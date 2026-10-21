import { App, LogLevel } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import { WebClient } from "@slack/web-api";
import { renderApprovalCard } from "../approvals/render.js";
import type { ApprovalService } from "../approvals/service.js";
import type { Agent } from "../agent/agent.js";
import type { BudgetService } from "../budget/service.js";
import type { GitHubClient } from "../github/client.js";
import type { ActionRecord } from "../store/actions.js";
import { renderDigest } from "../scheduler/digest.js";
import { buildQueue } from "../triage/queue.js";
import { decide, renderBudget, renderQueue, splitMessage } from "./shared.js";
import type { DecisionKind } from "./shared.js";

/** Slack recommends keeping a message under ~4000 characters; a block's text is limited to 3000. */
const MESSAGE_MAX = 3500;
const BLOCK_TEXT_MAX = 2900;

export const APPROVE_ACTION = "decision_approve";
export const REJECT_ACTION = "decision_reject";

export const slackActor = (userId: string): string => `slack:${userId}`;

/**
 * Make text safe to send as a Slack message. PR titles and comments are written by strangers,
 * and in Slack `<!channel>`, `<@U123>` and `<https://evil|Click here>` are live control sequences.
 * Escaping & < > (as Slack documents) turns all of them into harmless literal text.
 */
export function slackSafe(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The only Slack calls the channel needs. Small on purpose, so tests can fake it. */
export interface SlackApi {
  /** `channel` may be a channel id or a user id (a user id posts into that person's DM with the app). */
  post(channel: string, text: string, opts?: { threadTs?: string; blocks?: KnownBlock[] }): Promise<string | undefined>;
  remove(channel: string, ts: string): Promise<void>;
}

/** Posts through Slack's Web API with formatting and link previews switched off. */
export class BoltSlackApi implements SlackApi {
  private readonly dms = new Map<string, string>();

  constructor(private readonly client: WebClient) {}

  /** A person id (U... / W...) is turned into the id of the direct-message channel with the app. */
  private async resolve(target: string): Promise<string> {
    if (!/^[UW]/.test(target)) return target;
    const known = this.dms.get(target);
    if (known) return known;
    const opened = await this.client.conversations.open({ users: target });
    const id = opened.channel?.id;
    if (!id) throw new Error(`Could not open a direct message with ${target}`);
    this.dms.set(target, id);
    return id;
  }

  async post(target: string, text: string, opts: { threadTs?: string; blocks?: KnownBlock[] } = {}): Promise<string | undefined> {
    const res = await this.client.chat.postMessage({
      channel: await this.resolve(target),
      text: slackSafe(text), // with blocks, this is only the notification fallback
      ...(opts.blocks ? { blocks: opts.blocks } : {}),
      ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
      mrkdwn: false,
      unfurl_links: false,
      unfurl_media: false,
    });
    return res.ts;
  }

  async remove(channel: string, ts: string): Promise<void> {
    await this.client.chat.delete({ channel, ts });
  }
}

/** Slack ends a code block at three backticks, so a comment containing them is shown with invisible spacers. */
const ZWSP = "\u200b";
const neutralizeFences = (s: string): string => s.replace(/```/g, `\`${ZWSP}\`${ZWSP}\``);

/** Split text into pieces whose *escaped* length fits in `limit`, never dropping a character. */
function escapedChunks(raw: string, limit: number): string[] {
  const chunks: string[] = [];
  let current = "";
  const push = (piece: string): void => {
    const safe = slackSafe(piece);
    if (current && current.length + safe.length + 1 > limit) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n${safe}` : safe;
  };
  for (const line of raw.split("\n")) {
    if (slackSafe(line).length <= limit) {
      push(line);
      continue;
    }
    // A single very long line: cut it by characters.
    let piece = "";
    for (const ch of line) {
      if (slackSafe(piece + ch).length > limit) {
        push(piece);
        piece = "";
      }
      piece += ch;
    }
    if (piece) push(piece);
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [""];
}

const mrkdwn = (text: string): KnownBlock => ({ type: "section", text: { type: "mrkdwn", text } });

/**
 * Block Kit approval card with Approve / Reject buttons. The approver sees the exact text that would be posted,
 * in a code block, so formatting characters in it show literally and line breaks are kept. Everything that
 * came from a stranger is escaped first (`<!channel>` becomes harmless text). A long comment is split over
 * several blocks, never cut, so the approver always sees all of it.
 */
export function approvalBlocks(a: ActionRecord): KnownBlock[] {
  const head = [
    `*Approval needed* (#${a.id.slice(0, 8)})`,
    ``,
    `*Action:* post ONE public comment on pull request #${a.prNumber}`,
    `*PR:* ${slackSafe(a.prTitle)}`,
    `*Link:* ${slackSafe(a.prUrl)}`,
  ].join("\n");
  const bodyBlocks = escapedChunks(neutralizeFences(a.body), 2600).map((chunk, i) =>
    mrkdwn(`${i === 0 ? "*Exact comment text:*" : "*...continued:*"}\n\`\`\`${chunk}\`\`\``),
  );
  const tail = [
    `*Why the agent suggests it:* ${slackSafe((a.reason || "(no reason given)").slice(0, 1200))}`,
    `*Requested by* ${slackSafe(a.requestedBy)} via ${slackSafe(a.requestedVia)}`,
    `*Expires:* ${slackSafe(a.expiresAt)}`,
    ``,
    `_Nothing else will change. Without your approval nothing is posted._`,
  ].join("\n");
  return [
    mrkdwn(head),
    ...bodyBlocks,
    mrkdwn(tail),
    {
      type: "actions",
      block_id: "decision",
      elements: [
        {
          type: "button",
          action_id: APPROVE_ACTION,
          style: "primary",
          value: a.id,
          text: { type: "plain_text", text: "Approve and post" },
          confirm: {
            title: { type: "plain_text", text: "Post this comment?" },
            text: { type: "plain_text", text: "It will be posted to GitHub exactly as shown on the card." },
            confirm: { type: "plain_text", text: "Post it" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        },
        {
          type: "button",
          action_id: REJECT_ACTION,
          style: "danger",
          value: a.id,
          text: { type: "plain_text", text: "Reject" },
        },
      ],
    },
  ];
}

/** The same card after a decision: the buttons are replaced by the outcome. */
export function decidedBlocks(card: KnownBlock[], outcome: string): KnownBlock[] {
  return [
    ...card.filter((b) => b.type !== "actions"),
    { type: "divider" },
    { type: "section", text: { type: "plain_text", text: outcome.slice(0, 2900), emoji: false } },
  ];
}
/**
 * Turn a Slack API failure into something the person setting this up can act on.
 * Slack's own codes ("missing_scope", "invalid_auth") do not say which of the two tokens is at fault.
 */
export function explainSlackError(err: unknown, token: "SLACK_APP_TOKEN" | "SLACK_BOT_TOKEN"): string {
  const data = (err as { data?: { error?: string; needed?: string } } | undefined)?.data;
  const code = data?.error ?? (err instanceof Error ? err.message : String(err));
  if (code === "missing_scope") {
    return token === "SLACK_APP_TOKEN"
      ? "SLACK_APP_TOKEN is missing the connections:write scope. Create a new app-level token (Basic Information -> App-Level Tokens -> Generate Token) and tick connections:write."
      : `SLACK_BOT_TOKEN is missing a permission${data?.needed ? ` (${data.needed})` : ""}. Reinstall the app after updating its scopes from slack-app-manifest.yaml.`;
  }
  if (code === "invalid_auth" || code === "not_authed" || code === "token_revoked" || code === "account_inactive") {
    return `${token} was rejected by Slack (${code}). Copy it again from your app's settings.`;
  }
  return `${token}: ${code}`;
}

const HELP = [
  "I help your team decide which pull requests to review first, using live GitHub data.",
  "",
  "The best way to talk to me is to message me directly (the app's Messages tab): your questions and my answers stay in the conversation. In a channel, @mention me and I reply in a thread.",
  "Examples:",
  "- What should we review first?",
  "- Why is #12 blocked?",
  "- Leave a comment on #12 asking the author to fix CI (an approver must approve it first)",
  "",
  "Quick commands (replies are private to you and temporary):",
  "/triage queue - ranked review queue (no AI credit used)",
  "/triage pending - actions waiting for approval",
  "/triage digest - the morning digest, on demand",
  "/triage budget - AI budget status",
  "/triage <question> - ask without opening the conversation",
  "/triage help - this message",
].join("\n");

export interface SlackDeps {
  botToken: string;
  appToken: string;
  /** Slack member ids allowed to chat. Approvers are always allowed too. */
  allowedIds: string[];
  /** Slack member ids allowed to approve or reject. */
  approverIds: string[];
  agent: Agent;
  approvals: ApprovalService;
  github: Pick<GitHubClient, "listOpenPrs" | "getPr" | "repo">;
  budget: BudgetService;
  /** Tests inject a fake. In production this is created from the Bolt client on start. */
  api?: SlackApi;
}

/** Everything the rest of the app needs from the chat channel. */
export class SlackChannel {
  private app: App | undefined;
  private api: SlackApi | undefined;
  private botUserId: string | undefined;
  private readonly allowed: Set<string>;
  private readonly approvers: Set<string>;
  private readonly busy = new Set<string>();

  constructor(private readonly d: SlackDeps) {
    this.api = d.api;
    this.approvers = new Set(d.approverIds);
    this.allowed = new Set([...d.allowedIds, ...d.approverIds]);
  }

  isApprover(actorId: string): boolean {
    return this.approvers.has(actorId.replace(/^slack:/, ""));
  }

  private requireApi(): SlackApi {
    if (!this.api) throw new Error("Slack channel is not started yet.");
    return this.api;
  }

  /** Send plain text to a channel or a person (digest, budget alerts). Long text is split. */
  async send(target: string, text: string): Promise<void> {
    const api = this.requireApi();
    for (const part of splitMessage(text, MESSAGE_MAX)) await api.post(target, part);
  }

  /** Send a budget or system notice to every approver (the team's owners). */
  async notifyApprovers(text: string): Promise<void> {
    for (const id of this.approvers) {
      try {
        await this.send(id, text);
      } catch (err) {
        console.error(`Could not notify approver ${id}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  /**
   * Show an approval card (with buttons) to every approver. Returns how many received it.
   * The card text is rendered from the stored record, so approvers see exactly what would be posted.
   */
  async sendApprovalCards(record: ActionRecord): Promise<number> {
    const api = this.requireApi();
    let delivered = 0;
    for (const id of this.approvers) {
      try {
        await api.post(id, `Approval needed (#${record.id.slice(0, 8)}): comment on pull request #${record.prNumber}`, {
          blocks: approvalBlocks(record),
        });
        delivered += 1;
      } catch (err) {
        console.error(`Could not send approval card to ${id}:`, err instanceof Error ? err.message : err);
      }
    }
    return delivered;
  }

  // ---------------------------------------------------------------- handlers

  private deny(userId: string): string {
    return `You are not on the access list. Your Slack member ID is ${userId}; send it to the workspace admin to be added.`;
  }

  /** `/triage <text>`. `reply` answers privately to the person who typed it. */
  async handleCommand(p: { userId: string; text: string; reply: (text: string) => Promise<void> }): Promise<void> {
    const say = async (text: string): Promise<void> => {
      for (const part of splitMessage(text, MESSAGE_MAX)) await p.reply(part);
    };
    if (!this.allowed.has(p.userId)) return say(this.deny(p.userId));

    const [head = "", ...rest] = p.text.trim().split(/\s+/);
    const word = head.toLowerCase();
    // "/triage queue" is a command; "/triage queue what is blocking #3?" is a question.
    const isCommand = rest.length === 0;

    if (isCommand && (word === "" || word === "help")) return say(HELP);
    if (isCommand && word === "queue") return this.guarded(p.userId, say, async () => {
      try {
        await say(renderQueue(await buildQueue(this.d.github)));
      } catch (err) {
        await say(`I couldn't load the queue: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    });
    if (isCommand && word === "digest") return this.guarded(p.userId, say, async () => {
      try {
        await say(renderDigest(await buildQueue(this.d.github)));
      } catch (err) {
        await say(`I couldn't build the digest: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    });
    if (isCommand && word === "budget") return say(renderBudget(this.d.budget.summary()));
    if (isCommand && word === "pending") return this.showPending(p.userId, say);

    // Anything else is a question for the assistant. A slash command does not leave the question in the
    // chat and its reply is private and temporary, so the answer repeats the question to make sense alone.
    const question = p.text.trim();
    let first = true;
    return this.converse({
      userId: p.userId,
      conversationId: `slack:${p.userId}`,
      text: question,
      say: async (t) => {
        if (!first) return say(t);
        first = false;
        const shown = question.length > 300 ? `${question.slice(0, 300)}...` : question;
        return say(`You asked: ${shown}\n\n${t}`);
      },
    });
  }

  /** A direct message to the app, or an @mention in a channel. Answers in the same place (a thread in channels). */
  async handleMessage(p: { userId: string; channel: string; threadTs?: string; text: string }): Promise<void> {
    const api = this.requireApi();
    const opts = p.threadTs ? { threadTs: p.threadTs } : {};
    const post = async (text: string): Promise<void> => {
      for (const part of splitMessage(text, MESSAGE_MAX)) await api.post(p.channel, part, opts);
    };
    if (!this.allowed.has(p.userId)) return post(this.deny(p.userId));

    const text = this.stripMention(p.text);
    if (text === "" || /^help$/i.test(text)) return post(HELP);

    // A visible "working" note, replaced by the answer. Failing to show it must never block the answer.
    let placeholder: string | undefined;
    try {
      placeholder = await api.post(p.channel, "Looking at the pull requests...", opts);
    } catch {
      placeholder = undefined;
    }
    const clear = async (): Promise<void> => {
      if (!placeholder) return;
      const ts = placeholder;
      placeholder = undefined;
      await api.remove(p.channel, ts).catch(() => undefined);
    };

    return this.converse({
      userId: p.userId,
      conversationId: `slack:${p.channel}:${p.threadTs ?? p.userId}`,
      text,
      say: async (t) => {
        await clear();
        await post(t);
      },
      onDone: clear,
    });
  }

  /**
   * A click on Approve or Reject. `finish` shows the outcome on the card (and removes the buttons);
   * `notice` is a private message to the clicker.
   */
  async handleDecision(p: {
    userId: string;
    kind: DecisionKind;
    id: string;
    finish: (outcome: string) => Promise<void>;
    notice: (text: string) => Promise<void>;
  }): Promise<void> {
    const actor = slackActor(p.userId);
    // The ONLY check that matters is inside ApprovalService; this is just a friendlier early answer.
    if (!this.isApprover(actor)) return p.notice("Only approvers can do that.");

    const result = await decide(this.d.approvals, p.kind, p.id, actor);
    try {
      await p.finish(result.text);
    } catch {
      await p.notice(result.text);
    }

    // Tell the person who asked, if it was someone else.
    const requester = result.record?.requestedBy;
    if (requester?.startsWith("slack:") && requester !== actor) {
      await this.send(requester.replace("slack:", ""), `Your request #${p.id.slice(0, 8)}: ${result.text}`).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- internals

  private stripMention(text: string): string {
    const own = this.botUserId ? new RegExp(`<@${this.botUserId}>`, "g") : /<@[UW][A-Z0-9]+>/g;
    return text.replace(own, "").trim();
  }

  private async showPending(userId: string, say: (text: string) => Promise<void>): Promise<void> {
    const list = this.d.approvals.listPending();
    if (list.length === 0) return say("Nothing is waiting for approval.");
    if (!this.isApprover(slackActor(userId))) {
      await say(list.map(renderApprovalCard).join("\n\n----\n\n"));
      return say("You can see these, but only approvers can approve or reject them.");
    }
    // Cards with buttons go to the approver's DM with the app, not into a channel.
    const api = this.requireApi();
    for (const a of list) {
      await api.post(userId, `Approval needed (#${a.id.slice(0, 8)}): comment on pull request #${a.prNumber}`, {
        blocks: approvalBlocks(a),
      });
    }
    return say(`Sent ${list.length} approval card(s) to your direct messages with me.`);
  }

  /** One slow thing at a time per person (each model call costs money). */
  private async guarded(userId: string, say: (text: string) => Promise<void>, fn: () => Promise<void>): Promise<void> {
    const key = `cmd:${userId}`;
    if (this.busy.has(key)) return say("Still working on your last command.");
    this.busy.add(key);
    try {
      await fn();
    } finally {
      this.busy.delete(key);
    }
  }

  private async converse(p: {
    userId: string;
    conversationId: string;
    text: string;
    say: (text: string) => Promise<void>;
    onDone?: () => Promise<void>;
  }): Promise<void> {
    const key = `ask:${p.userId}`;
    if (this.busy.has(key)) {
      await p.say("I'm still working on your previous question. One moment.");
      return;
    }
    this.busy.add(key);
    try {
      const actor = slackActor(p.userId);
      const result = await this.d.agent.ask({
        conversationId: p.conversationId,
        text: p.text,
        actor,
        via: "slack",
        canPropose: true, // anyone on the access list may *ask*; only approvers can approve
      });
      await p.say(result.text);
      for (const record of result.proposed) {
        const n = await this.sendApprovalCards(record);
        await p.say(
          n > 0
            ? `Sent for approval (#${record.id.slice(0, 8)}). Nothing is posted until an approver approves it.`
            : `Created request #${record.id.slice(0, 8)}, but I could not reach any approver on Slack. It stays pending for 24h and can be approved from the web page. Nothing is posted yet.`,
        );
      }
    } catch (err) {
      console.error("Slack answer failed:", err instanceof Error ? err.message : err);
      await p.say("Something went wrong on my side. Nothing was changed. Please try again.").catch(() => undefined);
    } finally {
      await p.onDone?.().catch(() => undefined);
      this.busy.delete(key);
    }
  }

  // ---------------------------------------------------------------- Slack connection

  /**
   * Connect with Socket Mode: the app opens an outbound WebSocket to Slack, so no public URL or
   * inbound webhook is needed. Fails fast, with Slack's own error, if a token is wrong.
   */
  async start(): Promise<void> {
    // Check both tokens first. Bolt retries a bad app token forever in the background, which looks like a hang.
    try {
      await new WebClient(this.d.appToken).apps.connections.open();
    } catch (err) {
      throw new Error(`Could not connect to Slack: ${explainSlackError(err, "SLACK_APP_TOKEN")}`);
    }
    try {
      await new WebClient(this.d.botToken).auth.test();
    } catch (err) {
      throw new Error(`Could not connect to Slack: ${explainSlackError(err, "SLACK_BOT_TOKEN")}`);
    }

    const app = new App({
      token: this.d.botToken,
      appToken: this.d.appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });
    this.app = app;
    this.api = this.d.api ?? new BoltSlackApi(app.client);

    app.command("/triage", async ({ command, ack, respond }) => {
      await ack(); // Slack needs an answer within 3 seconds; the work happens after.
      void this.handleCommand({
        userId: command.user_id,
        text: command.text,
        reply: async (text) => {
          await respond({ response_type: "ephemeral", text: slackSafe(text), mrkdwn: false });
        },
      }).catch((err) => console.error("Slack command failed:", err instanceof Error ? err.message : err));
    });

    app.event("app_mention", async ({ event }) => {
      if (!event.user) return;
      void this.handleMessage({
        userId: event.user,
        channel: event.channel,
        threadTs: event.thread_ts ?? event.ts,
        text: event.text,
      }).catch((err) => console.error("Slack mention failed:", err instanceof Error ? err.message : err));
    });

    app.message(async ({ message }) => {
      const m = message as { user?: string; text?: string; channel: string; channel_type?: string; subtype?: string; bot_id?: string };
      // Only direct messages from people (never our own or other bots' messages, edits, joins...).
      if (m.channel_type !== "im" || m.subtype || m.bot_id || !m.user || !m.text) return;
      void this.handleMessage({ userId: m.user, channel: m.channel, text: m.text }).catch((err) =>
        console.error("Slack message failed:", err instanceof Error ? err.message : err),
      );
    });

    const onClick = (kind: DecisionKind) =>
      async ({ ack, body, action, respond }: {
        ack: () => Promise<void>;
        body: { user: { id: string }; message?: { blocks?: unknown[] } };
        action: { value?: string };
        respond: (m: { replace_original: boolean; text: string; blocks: KnownBlock[] }) => Promise<unknown>;
      }): Promise<void> => {
        await ack();
        const id = action.value;
        if (!id) return;
        // Keep the card the approver saw and swap the buttons for the outcome.
        const card = (body.message?.blocks ?? []) as KnownBlock[];
        await this.handleDecision({
          userId: body.user.id,
          kind,
          id,
          finish: async (outcome) => {
            await respond({
              replace_original: true,
              text: slackSafe(outcome),
              blocks: decidedBlocks(card, outcome),
            });
          },          notice: async (text) => {
            await this.requireApi().post(body.user.id, text);
          },
        }).catch((err) => console.error("Slack decision failed:", err instanceof Error ? err.message : err));
      };
    app.action(APPROVE_ACTION, onClick("approve") as never);
    app.action(REJECT_ACTION, onClick("reject") as never);

    app.error(async (err) => console.error("Slack error:", err.message));

    try {
      await app.start();
      const me = await app.client.auth.test();
      this.botUserId = me.user_id;
      console.log(`Slack app connected as @${me.user ?? "app"} in workspace ${me.team ?? "?"}`);
    } catch (err) {
      throw new Error(`Could not connect to Slack: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async stop(): Promise<void> {
    await this.app?.stop();
  }
}
