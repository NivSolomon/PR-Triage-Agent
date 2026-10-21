import { App, LogLevel } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import type { WebClient } from "@slack/web-api";
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
  constructor(private readonly client: WebClient) {}

  async post(channel: string, text: string, opts: { threadTs?: string; blocks?: KnownBlock[] } = {}): Promise<string | undefined> {
    const res = await this.client.chat.postMessage({
      channel,
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

/**
 * Block Kit approval card with Approve / Reject buttons. The card shows the exact text that would
 * be posted. Text is `plain_text`, which Slack never parses for mentions or links. Long cards are split
 * across several blocks instead of being cut, so the approver always sees the whole comment.
 */
export function approvalBlocks(record: ActionRecord, cardText: string = renderApprovalCard(record)): KnownBlock[] {
  const sections: KnownBlock[] = splitMessage(cardText, BLOCK_TEXT_MAX).map((part) => ({
    type: "section",
    text: { type: "plain_text", text: part, emoji: false },
  }));
  return [
    ...sections,
    {
      type: "actions",
      block_id: "decision",
      elements: [
        {
          type: "button",
          action_id: APPROVE_ACTION,
          style: "primary",
          value: record.id,
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
          value: record.id,
          text: { type: "plain_text", text: "Reject" },
        },
      ],
    },
  ];
}

/** The card after a decision: same text plus the outcome, and no buttons. */
export function decidedBlocks(cardText: string, outcome: string): KnownBlock[] {
  return splitMessage(`${cardText}\n\n=> ${outcome}`, BLOCK_TEXT_MAX).map((part) => ({
    type: "section",
    text: { type: "plain_text", text: part, emoji: false },
  }));
}

const HELP = [
  "I help your team decide which pull requests to review first, using live GitHub data.",
  "",
  "Message me here, or type /triage followed by a question, for example:",
  "- What should we review first?",
  "- Why is #12 blocked?",
  "- Leave a comment on #12 asking the author to fix CI (an approver must approve it first)",
  "",
  "Commands:",
  "/triage queue - ranked review queue (no AI credit used)",
  "/triage pending - actions waiting for approval",
  "/triage digest - the morning digest, on demand",
  "/triage budget - AI budget status",
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

    // Anything else is a question for the assistant.
    return this.converse({
      userId: p.userId,
      conversationId: `slack:${p.userId}`,
      text: p.text.trim(),
      say,
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
   * A click on Approve or Reject. `finish` replaces the card with the outcome (and removes the buttons);
   * `notice` is a private message to the clicker.
   */
  async handleDecision(p: {
    userId: string;
    kind: DecisionKind;
    id: string;
    cardText: string;
    finish: (cardText: string, outcome: string) => Promise<void>;
    notice: (text: string) => Promise<void>;
  }): Promise<void> {
    const actor = slackActor(p.userId);
    // The ONLY check that matters is inside ApprovalService; this is just a friendlier early answer.
    if (!this.isApprover(actor)) return p.notice("Only approvers can do that.");

    const result = await decide(this.d.approvals, p.kind, p.id, actor);
    try {
      await p.finish(p.cardText, result.text);
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
        body: { user: { id: string }; message?: { blocks?: Array<{ type?: string; text?: { text?: string } }> } };
        action: { value?: string };
        respond: (m: { replace_original: boolean; text: string; blocks: KnownBlock[] }) => Promise<unknown>;
      }): Promise<void> => {
        await ack();
        const id = action.value;
        if (!id) return;
        // Recover the card text we rendered, so the outcome is appended to what the approver saw.
        const cardText =
          (body.message?.blocks ?? [])
            .filter((b) => b.type === "section")
            .map((b) => b.text?.text ?? "")
            .join("\n") || `Request #${id.slice(0, 8)}`;
        await this.handleDecision({
          userId: body.user.id,
          kind,
          id,
          cardText,
          finish: async (card, outcome) => {
            await respond({
              replace_original: true,
              text: slackSafe(outcome),
              blocks: decidedBlocks(card, outcome),
            });
          },
          notice: async (text) => {
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
      throw new Error(
        `Could not connect to Slack: ${err instanceof Error ? err.message : String(err)}. Check SLACK_BOT_TOKEN and SLACK_APP_TOKEN.`,
      );
    }
  }

  async stop(): Promise<void> {
    await this.app?.stop();
  }
}
