import { App, LogLevel } from "@slack/bolt";
import type { KnownBlock, ModalView } from "@slack/types";
import { WebClient } from "@slack/web-api";
import { containsAtMention, renderApprovalCard, renderOutcome } from "../approvals/render.js";
import { buildGuide, renderGuideText } from "../guide.js";
import type { ApprovalService } from "../approvals/service.js";
import type { Agent } from "../agent/agent.js";
import type { BudgetPort } from "../budget/service.js";
import type { GitHubReader } from "../github/port.js";
import type { ActionRecord } from "../store/actions.js";
import { renderDigest } from "../scheduler/digest.js";
import { homeBlocks, homeDeniedBlocks } from "./slackHome.js";
import { slackSafe } from "./slack-text.js";
import { count } from "../text/en.js";
import { buildQueue } from "../triage/queue.js";
import { decide, renderBudget, renderQueue, splitMessage } from "./shared.js";
import { SLACK_COMMANDS, SLACK_EXAMPLES } from "../prompts/bank.js";
import type { DecisionKind } from "./shared.js";
import { FoldedLists, isMoreRequest } from "../text/fold-list.js";

/** Slack recommends keeping a message under ~4000 characters; a block's text is limited to 3000. */
const MESSAGE_MAX = 3500;
/** Shown while the agent runs, then deleted. Generic: the user may have said "hi", not asked about a PR. */
export const THINKING_NOTE = "Thinking…";

export const APPROVE_ACTION = "decision_approve";
export const REJECT_ACTION = "decision_reject";
export const EDIT_ACTION = "decision_edit";
/** callback_id of the pop-up where an approver corrects the comment before posting it. */
export const EDIT_VIEW = "edit_comment";
const COMMENT_MAX = 2000;

export const slackActor = (userId: string): string => `slack:${userId}`;

/** Shape of a Slack `message` event, including an edit (`subtype: message_changed`). */
export interface SlackMessageEvent {
  channel?: string;
  channel_type?: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  user_team?: string;
  text?: string;
  message?: { user?: string; text?: string; bot_id?: string; subtype?: string; ts?: string; thread_ts?: string };
  previous_message?: { text?: string };
}

/**
 * A DM we should answer, or null to ignore (bots, joins, deletes, unchanged edits).
 * Slack delivers an *edit* as a different event (`message_changed`); Bolt's `app.message` skips those,
 * so callers must listen to `message` itself.
 */
export function incomingDirectMessage(
  event: SlackMessageEvent | unknown,
): { userId: string; teamId?: string; channel: string; text: string } | null {
  if (!event || typeof event !== "object") return null;
  const e = event as SlackMessageEvent;
  if (e.channel_type !== "im" || !e.channel) return null;

  if (e.subtype === "message_changed") {
    const inner = e.message;
    if (!inner || inner.bot_id || inner.subtype || !inner.user || !inner.text) return null;
    const next = inner.text.trim();
    const prev = (e.previous_message?.text ?? "").trim();
    if (!next || next === prev) return null;
    return { userId: inner.user, teamId: e.user_team, channel: e.channel, text: inner.text };
  }

  if (e.subtype || e.bot_id || !e.user || !e.text) return null;
  return { userId: e.user, teamId: e.user_team, channel: e.channel, text: e.text };
}

/**
 * An edit of an @mention in a channel or private channel. New mentions still arrive as `app_mention`;
 * Slack does not re-send that event when the text is edited, so this watches `message_changed`.
 * Requires `channels:history` / `groups:history`. Without `botUserId` we cannot tell a mention from
 * every other edit, so we ignore it.
 */
export function incomingEditedMention(
  event: SlackMessageEvent | unknown,
  botUserId: string | undefined,
): { userId: string; teamId?: string; channel: string; threadTs?: string; text: string } | null {
  if (!botUserId || !event || typeof event !== "object") return null;
  const e = event as SlackMessageEvent;
  if (e.subtype !== "message_changed" || !e.channel) return null;
  if (e.channel_type === "im") return null;

  const inner = e.message;
  if (!inner || inner.bot_id || inner.subtype || !inner.user || !inner.text) return null;
  const next = inner.text.trim();
  const prev = (e.previous_message?.text ?? "").trim();
  if (!next || next === prev) return null;

  const mention = `<@${botUserId}>`;
  if (!next.includes(mention)) return null;

  return {
    userId: inner.user,
    teamId: e.user_team,
    channel: e.channel,
    threadTs: inner.thread_ts ?? inner.ts,
    text: inner.text,
  };
}

export { slackSafe };

/** A message we posted, with the resolved channel id Slack needs for later updates. */
export interface PostedSlackMessage {
  channel: string;
  ts: string;
}

/** The only Slack calls the channel needs. Small on purpose, so tests can fake it. */
export interface SlackApi {
  /** `channel` may be a channel id or a user id (a user id posts into that person's DM with the app). */
  post(channel: string, text: string, opts?: { threadTs?: string; blocks?: KnownBlock[] }): Promise<PostedSlackMessage | undefined>;
  remove(channel: string, ts: string): Promise<void>;
  /** Replace the contents of the app's Home tab for one person. */
  publishHome(userId: string, blocks: KnownBlock[]): Promise<void>;
  /** Replace an earlier message (for example an approval card, once it has been decided). */
  update(channel: string, ts: string, text: string, blocks: KnownBlock[]): Promise<void>;
}

/** Posts through Slack's Web API with formatting and link previews switched off. */
class BoltSlackApi implements SlackApi {
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

  async post(target: string, text: string, opts: { threadTs?: string; blocks?: KnownBlock[] } = {}): Promise<PostedSlackMessage | undefined> {
    const channel = await this.resolve(target);
    const res = await this.client.chat.postMessage({
      channel,
      text: slackSafe(text),
      ...(opts.blocks ? { blocks: opts.blocks } : {}),
      ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
      mrkdwn: false,
      unfurl_links: false,
      unfurl_media: false,
    });
    // Slack's channel id (D... for a DM) is what chat.update needs later, not the user id we posted to.
    const postedChannel = typeof res.channel === "string" && res.channel ? res.channel : channel;
    return res.ts ? { channel: postedChannel, ts: res.ts } : undefined;
  }

  async remove(channel: string, ts: string): Promise<void> {
    await this.client.chat.delete({ channel, ts });
  }

  async update(channel: string, ts: string, text: string, blocks: KnownBlock[]): Promise<void> {
    await this.client.chat.update({
      channel: await this.resolve(channel),
      ts,
      text: slackSafe(text),
      blocks,
    });
  }

  async publishHome(userId: string, blocks: KnownBlock[]): Promise<void> {
    await this.client.views.publish({ user_id: userId, view: { type: "home", blocks } });
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
    `*Action:* post one public comment on pull request #${a.prNumber}`,
    `*PR:* ${slackSafe(a.prTitle)}`,
    `*Link:* ${slackSafe(a.prUrl)}`,
  ].join("\n");
  const bodyBlocks = escapedChunks(neutralizeFences(a.body), 2600).map((chunk, i) =>
    mrkdwn(`${i === 0 ? "*Exact comment text:*" : "*...continued:*"}\n\`\`\`${chunk}\`\`\``),
  );
  // After an approver edited the text, the card keeps the draft it replaced.
  const originalBlocks = a.originalBody
    ? escapedChunks(neutralizeFences(a.originalBody), 2600).map((chunk, i) =>
        mrkdwn(`${i === 0 ? "*Edited by the approver. The original draft was:*" : "*...continued:*"}\n\`\`\`${chunk}\`\`\``),
      )
    : [];
  const mention = containsAtMention(a.body)
    ? `_This comment @-mentions someone. Approving will notify them on GitHub._\n`
    : "";
  const tail = [
    `*Why the agent suggests it:* ${slackSafe((a.reason || "(no reason given)").slice(0, 1200))}`,
    `*Requested by* ${slackSafe(a.requestedBy)} via ${slackSafe(a.requestedVia)}`,
    `*Expires:* ${slackSafe(a.expiresAt)}`,
    ``,
    mention + `_Nothing else will change. Without your approval, nothing is posted._`,
  ].join("\n");
  return [
    mrkdwn(head),
    ...bodyBlocks,
    ...originalBlocks,
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
          action_id: EDIT_ACTION,
          value: a.id,
          text: { type: "plain_text", text: "Edit text" },
        },
        {
          type: "button",
          action_id: REJECT_ACTION,
          style: "danger",
          value: a.id,
          text: { type: "plain_text", text: "Reject" },
          confirm: {
            title: { type: "plain_text", text: "Reject this request?" },
            text: { type: "plain_text", text: "Nothing will be posted to GitHub." },
            confirm: { type: "plain_text", text: "Reject" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        },
      ],
    },
  ];
}

/**
 * The pop-up for correcting a comment. The approver sees the current text, changes it, and submits to post it.
 * The submit button says what it does, because submitting IS the approval. `card` says which message to
 * update afterwards.
 */
export function editModal(a: ActionRecord, card: { channel?: string; ts?: string }): ModalView {
  return {
    type: "modal",
    callback_id: EDIT_VIEW,
    private_metadata: JSON.stringify({ id: a.id, channel: card.channel, ts: card.ts }),
    title: { type: "plain_text", text: "Edit comment" },
    submit: { type: "plain_text", text: "Post this comment" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      mrkdwn(`Comment on pull request #${a.prNumber}: *${slackSafe(a.prTitle).slice(0, 200)}*`),
      {
        type: "input",
        block_id: "body",
        label: { type: "plain_text", text: "Exact text to post" },
        element: {
          type: "plain_text_input",
          action_id: "text",
          multiline: true,
          initial_value: a.body.slice(0, COMMENT_MAX),
          max_length: COMMENT_MAX,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Your text replaces the draft and is posted exactly as written. The original draft stays in the history.",
          },
        ],
      },
    ],
  };
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

/**
 * The help message. The part about what you may and may not do depends on who is asking
 * (an approver or not) and comes from the same guide as the web page.
 */
export function helpText(isApprover: boolean): string {
  return [
    "I help your team decide which pull requests to review first, using live GitHub data.",
    "",
    renderGuideText(buildGuide(isApprover ? "approver" : "requester", { channel: "slack" })),
    "",
    "How to talk to me: message me directly (the app's Messages tab). Your questions and my answers stay in the conversation. In a channel, @mention me and I reply in a thread. If you edit a DM or an @mention, I treat the new text as a new question.",
    "Examples:",
    ...SLACK_EXAMPLES.map((e) => `- ${e}`),
    "",
    "Quick commands (replies are private to you and temporary):",
    ...SLACK_COMMANDS.map(([c, d]) => `${c} - ${d}`),
  ].join("\n");
}

export interface SlackDeps {
  botToken: string;
  appToken: string;
  /** Slack member ids allowed to chat. Approvers are always allowed too. */
  allowedIds: string[];
  /**
   * Let every member of this workspace chat *and* approve, instead of only the named lists.
   * Slack Connect (another workspace) is still refused. `approverIds` still get budget alerts
   * and a DM of every card; the team channel also gets the card so testers can click it.
   */
  allowAllMembers?: boolean;
  /** Slack member ids allowed to approve or reject (and always allowed to chat). */
  approverIds: string[];
  /** Team channel (digest, and approval cards when `allowAllMembers`). */
  teamChannelId?: string;
  /** Slack member id -> GitHub login, for the personal queue. Optional. */
  githubUsers?: Record<string, string>;
  agent: Agent;
  approvals: ApprovalService;
  github: GitHubReader;
  budget: Pick<BudgetPort, "summary">;
  /** Tests inject a fake. In production this is created from the Bolt client on start. */
  api?: SlackApi;
  /** Our workspace id (T...). Normally learned from Slack on start; tests set it. */
  teamId?: string;
}

/** Everything the rest of the app needs from the chat channel. */
export class SlackChannel {
  private app: App | undefined;
  private api: SlackApi | undefined;
  private botUserId: string | undefined;
  /** The workspace this app is installed in (learned from Slack on start). */
  private homeTeam: string | undefined;
  private readonly allowed: Set<string>;
  private readonly approvers: Set<string>;
  private readonly busy = new Set<string>();
  /** Hidden tail of a long ranked list, revealed with "more" without another model call. */
  private readonly folded = new FoldedLists();

  constructor(private readonly d: SlackDeps) {
    this.api = d.api;
    this.homeTeam = d.teamId;
    this.approvers = new Set(d.approverIds);
    this.allowed = new Set([...d.allowedIds, ...d.approverIds]);
  }

  /**
   * May this Slack person approve? Named approvers always; when `allowAllMembers`, anyone in
   * this workspace. `teamId` is the person's home workspace (Slack Connect is refused).
   */
  isApprover(actorId: string, teamId?: string): boolean {
    const userId = actorId.startsWith("slack:") ? actorId.slice("slack:".length) : "";
    if (userId && this.approvers.has(userId)) return true;
    if (this.d.allowAllMembers !== true) return false;
    if (!userId) return false;
    if (this.homeTeam && teamId && teamId !== this.homeTeam) return false;
    return true;
  }

  /** The GitHub login linked to this Slack member, if the owner configured one. */
  private githubLogin(userId: string): string | undefined {
    return this.d.githubUsers?.[userId];
  }

  private hasGithubMap(): boolean {
    return Object.keys(this.d.githubUsers ?? {}).length > 0;
  }

  private readonly UNLINKED_TIP =
    "Tip: your Slack account is not linked to a GitHub login, so this list is not personal. Ask the admin to add <your member id>:<your GitHub login> to SLACK_GITHUB_USERS.";

  /** May this person talk to the agent? When `allowAllMembers`, the same people may also approve. */
  private canChat(userId: string, teamId?: string): boolean {
    if (this.allowed.has(userId)) return true;
    if (this.d.allowAllMembers !== true) return false;
    // Slack Connect lets people from OTHER workspaces mention the app in a shared channel. "Everyone" means
    // everyone in OUR workspace, so a message that Slack says came from another workspace is refused.
    if (this.homeTeam && teamId && teamId !== this.homeTeam) return false;
    return true;
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
   * Show an approval card (with buttons). Named approvers always get a DM. When the workspace
   * invite is the gate, the person who asked and the team channel get it too, so testers can click
   * Approve without being listed. Returns how many deliveries succeeded.
   */
  async sendApprovalCards(record: ActionRecord, replaced: ActionRecord[] = []): Promise<number> {
    const api = this.requireApi();
    const targets = new Set<string>(this.approvers);
    if (this.d.allowAllMembers === true) {
      if (this.d.teamChannelId) targets.add(this.d.teamChannelId);
      if (record.requestedBy?.startsWith("slack:")) targets.add(record.requestedBy.slice("slack:".length));
    }
    if (replaced.length > 0) await this.retireCards(replaced);
    const blocks = approvalBlocks(record);
    if (replaced.length > 0) {
      const ids = replaced.map((a) => `#${a.id.slice(0, 8)}`).join(", ");
      blocks.splice(
        blocks.length - 1,
        0,
        mrkdwn(`_This replaces ${ids} on the same pull request. Those older cards no longer have Approve buttons._`),
      );
    }
    let delivered = 0;
    for (const id of targets) {
      try {
        const posted = await api.post(
          id,
          `Approval needed (#${record.id.slice(0, 8)}): comment on pull request #${record.prNumber}`,
          { blocks },
        );
        if (posted) {
          try {
            this.d.approvals.rememberCard(record.id, posted.channel, posted.ts);
          } catch (err) {
            console.error(
              `Posted the approval card to ${id} but could not remember ${posted.channel}/${posted.ts}:`,
              err instanceof Error ? err.message : err,
            );
          }
          delivered += 1;
        }
      } catch (err) {
        console.error(`Could not send approval card to ${id}:`, err instanceof Error ? err.message : err);
      }
    }
    return delivered;
  }

  /**
   * Replace Approve / Reject buttons on every stored copy of these cards with the outcome.
   * Used when a request is replaced, rejected, expired, or recovered after a crash - not only
   * when someone clicks the card that Slack delivered this event for.
   */
  async retireCards(records: ActionRecord[]): Promise<void> {
    if (!this.api) return;
    const api = this.api;
    for (const record of records) {
      if (record.status === "pending" || record.status === "executing") continue;
      const outcome = renderOutcome(record);
      const blocks = decidedBlocks(approvalBlocks(record), outcome);
      for (const card of this.d.approvals.cardsFor(record.id)) {
        try {
          await api.update(card.channel, card.ts, outcome, blocks);
        } catch (err) {
          console.error(
            `Could not update Slack card ${card.channel}/${card.ts}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  }

  // ---------------------------------------------------------------- handlers

  private deny(userId: string): string {
    return `You are not on the access list. Your Slack member ID is ${userId}; send it to the workspace admin to be added.`;
  }

  /** `/triage <text>`. `reply` answers privately to the person who typed it. */
  async handleCommand(p: { userId: string; teamId?: string; text: string; reply: (text: string) => Promise<void> }): Promise<void> {
    const say = async (text: string): Promise<void> => {
      for (const part of splitMessage(text, MESSAGE_MAX)) await p.reply(part);
    };
    if (!this.canChat(p.userId, p.teamId)) return say(this.deny(p.userId));

    const [head = "", ...rest] = p.text.trim().split(/\s+/);
    const word = head.toLowerCase();
    // "/triage queue" is a command; "/triage queue what is blocking #3?" is a question.
    const isCommand = rest.length === 0;

    if (isCommand && (word === "" || word === "help")) return say(helpText(this.isApprover(slackActor(p.userId), p.teamId)));
    if (isCommand && word === "queue") return this.guarded(p.userId, say, async () => {
      try {
        const login = this.githubLogin(p.userId);
        const raw = renderQueue(await buildQueue(this.d.github), login ? { login } : undefined);
        const text = login || !this.hasGithubMap() ? raw : `${raw}\n\n${this.UNLINKED_TIP}`;
        await say(this.folded.foldOutgoing(`slack:${p.userId}`, text));
      } catch (err) {
        await say(`I could not load the queue: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    });
    if (isCommand && word === "digest") return this.guarded(p.userId, say, async () => {
      try {
        await say(renderDigest(await buildQueue(this.d.github)));
      } catch (err) {
        await say(`I could not build the digest: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    });
    if (isCommand && word === "budget") return say(renderBudget(this.d.budget.summary()));
    if (isCommand && word === "pending") return this.showPending(p.userId, say);

    // Anything else is a question for the assistant. A slash command does not leave the question in the
    // chat and its reply is private and temporary, so the answer repeats the question to make sense alone.
    const question = p.text.trim();
    if (isMoreRequest(question)) {
      const next = this.folded.take(`slack:${p.userId}`);
      if (next) return say(next.text);
    }
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
  async handleMessage(p: { userId: string; teamId?: string; channel: string; threadTs?: string; text: string }): Promise<void> {
    const api = this.requireApi();
    const opts = p.threadTs ? { threadTs: p.threadTs } : {};
    const post = async (text: string): Promise<void> => {
      for (const part of splitMessage(text, MESSAGE_MAX)) await api.post(p.channel, part, opts);
    };
    if (!this.canChat(p.userId, p.teamId)) return post(this.deny(p.userId));

    const text = this.stripMention(p.text);
    if (text === "" || /^help$/i.test(text)) return post(helpText(this.isApprover(slackActor(p.userId), p.teamId)));

    const conversationId = `slack:${p.channel}:${p.threadTs ?? "root"}:${p.userId}`;
    if (isMoreRequest(text)) {
      const next = this.folded.take(conversationId);
      if (next) return post(next.text);
    }

    // A visible "thinking" note, replaced by the answer. Failing to show it must never block the answer.
    let placeholder: string | undefined;
    try {
      placeholder = (await api.post(p.channel, THINKING_NOTE, opts))?.ts;
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
      conversationId,
      text,
      say: async (t) => {
        await clear();
        await post(t);
      },
      onDone: clear,
    });
  }

  /**
   * A click on Edit: open the pop-up with the current text. Only approvers may; everyone else, and anything
   * already decided, gets a plain message and no pop-up. (The real permission check is in ApprovalService.)
   */
  async handleEditClick(p: {
    userId: string;
    /** The person's home workspace; used to refuse Slack Connect when `allowAllMembers`. */
    teamId?: string;
    id: string;
    channel?: string;
    ts?: string;
    open: (view: ModalView) => Promise<void>;
    notice: (text: string) => Promise<void>;
  }): Promise<void> {
    if (!this.isApprover(slackActor(p.userId), p.teamId)) return p.notice("Only approvers can do that.");
    const record = this.d.approvals.get(p.id);
    if (!record) return p.notice("I cannot find that request any more.");
    if (record.status !== "pending") return p.notice(renderOutcome(record));
    await p.open(editModal(record, { channel: p.channel, ts: p.ts }));
  }

  /**
   * A click on Approve or Reject. `finish` shows the outcome on the card that was clicked;
   * every other stored copy (the app DM, the team channel, other approvers) is updated too.
   * `notice` is a private message to the clicker.
   */
  async handleDecision(p: {
    userId: string;
    /** The person's home workspace; used to refuse Slack Connect when `allowAllMembers`. */
    teamId?: string;
    kind: DecisionKind;
    id: string;
    /** Approve only: the approver corrected the text in the pop-up. */
    editedBody?: string;
    /** The Slack message that was clicked, so we can remember it if send-time tracking missed it. */
    card?: { channel?: string; ts?: string };
    finish: (outcome: string, record?: ActionRecord) => Promise<void>;
    notice: (text: string) => Promise<void>;
  }): Promise<void> {
    const actor = slackActor(p.userId);
    // The ONLY check that matters is inside ApprovalService; this is just a friendlier early answer.
    if (!this.isApprover(actor, p.teamId)) return p.notice("Only approvers can do that.");

    const result = await decide(this.d.approvals, p.kind, p.id, actor, p.editedBody);
    const done = result.record ?? this.d.approvals.get?.(p.id) ?? undefined;
    if (done && p.card?.channel && p.card.ts) {
      try {
        this.d.approvals.rememberCard(done.id, p.card.channel, p.card.ts);
      } catch (err) {
        console.error(
          `Could not remember Slack card ${p.card.channel}/${p.card.ts}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    try {
      await p.finish(result.text, result.record);
    } catch {
      await p.notice(result.text);
    }
    // Slack's replace_original only rewrites the message that was clicked. The same request is
    // also posted to the app DM and the team channel; close those copies too.
    if (done) await this.retireCards([done]);

    // Tell the person who asked, if it was someone else.
    const requester = result.record?.requestedBy;
    if (requester?.startsWith("slack:") && requester !== actor) {
      await this.send(requester.replace("slack:", ""), `Your request #${p.id.slice(0, 8)}: ${result.text}`).catch(() => undefined);
    }
  }

  /** Someone opened the app's Home tab: show them the guide (or how to get access). */
  async handleHomeOpened(userId: string): Promise<void> {
    const api = this.requireApi();
    if (!this.canChat(userId)) return api.publishHome(userId, homeDeniedBlocks(userId));
    let budgetLevel: string | undefined;
    let pending: number | undefined;
    try {
      budgetLevel = this.d.budget.summary().level;
      await this.d.approvals.dropStalePending?.();
      pending = this.d.approvals.listPending().length;
    } catch {
      // The guide is useful without the live numbers.
    }
    await api.publishHome(
      userId,
      homeBlocks({
        repo: this.d.github.repo,
        audience: this.isApprover(slackActor(userId)) ? "approver" : "requester",
        budgetLevel,
        pending,
      }),
    );
  }

  // ---------------------------------------------------------------- internals

  private stripMention(text: string): string {
    const own = this.botUserId ? new RegExp(`<@${this.botUserId}>`, "g") : /<@[UW][A-Z0-9]+>/g;
    return text.replace(own, "").trim();
  }

  private async showPending(userId: string, say: (text: string) => Promise<void>): Promise<void> {
    await this.d.approvals.dropStalePending?.();
    const list = this.d.approvals.listPending();
    if (list.length === 0) return say("Nothing is waiting for approval.");
    if (!this.isApprover(slackActor(userId))) {
      await say(list.map(renderApprovalCard).join("\n\n----\n\n"));
      return say("You can see these, but only approvers can approve or reject them.");
    }
    // Cards with buttons go to the approver's DM with the app, not into a channel.
    const api = this.requireApi();
    for (const a of list) {
      const posted = await api.post(userId, `Approval needed (#${a.id.slice(0, 8)}): comment on pull request #${a.prNumber}`, {
        blocks: approvalBlocks(a),
      });
      if (posted) this.d.approvals.rememberCard(a.id, posted.channel, posted.ts);
    }
    return say(`Sent ${count(list.length, "approval card")} to your direct messages with me.`);
  }

  /** One slow thing at a time per person (each model call costs money). */
  private async guarded(userId: string, say: (text: string) => Promise<void>, fn: () => Promise<void>): Promise<void> {
    const key = `cmd:${userId}`;
    if (this.busy.has(key)) return say("I am still working on your last command.");
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
      await p.say("I am still working on your previous question. Please wait a moment.");
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
        githubLogin: this.githubLogin(p.userId),
      });
      await p.say(this.folded.foldOutgoing(p.conversationId, result.text));
      for (const record of result.proposed) {
        const mine = result.replaced.filter((a) => a.prNumber === record.prNumber);
        const n = await this.sendApprovalCards(record, mine);
        await p.say(
          n > 0
            ? `Sent for approval (#${record.id.slice(0, 8)}). Nothing is posted until an approver approves it.`
            : `Created request #${record.id.slice(0, 8)}, but I could not reach any approver on Slack. It stays pending for 24 hours and can be approved from the web page. Nothing is posted yet.`,
        );
        if (mine.length > 0) {
          await p.say(
            `Your earlier pending comment on #${record.prNumber} was withdrawn. The older card no longer has Approve buttons.`,
          );
        }
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
        teamId: command.team_id,
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
        teamId: (event as { user_team?: string }).user_team,
        channel: event.channel,
        threadTs: event.thread_ts ?? event.ts,
        text: event.text,
      }).catch((err) => console.error("Slack mention failed:", err instanceof Error ? err.message : err));
    });

    app.event("app_home_opened", async ({ event }) => {
      if (event.tab !== "home") return; // the Messages tab is the conversation itself
      void this.handleHomeOpened(event.user).catch((err) =>
        console.error("Slack home tab failed:", err instanceof Error ? err.message : err),
      );
    });

    // `app.message` skips edits (they arrive as subtype message_changed). Listen to the raw event instead.
    app.event("message", async ({ event }) => {
      const incoming = incomingDirectMessage(event) ?? incomingEditedMention(event, this.botUserId);
      if (!incoming) return;
      void this.handleMessage(incoming).catch((err) =>
        console.error("Slack message failed:", err instanceof Error ? err.message : err),
      );
    });

    const onClick = (kind: DecisionKind) =>
      async ({ ack, body, action, respond }: {
        ack: () => Promise<void>;
        body: {
          user: { id: string; team_id?: string };
          team?: { id?: string };
          channel?: { id?: string };
          container?: { channel_id?: string; message_ts?: string };
          message?: { ts?: string; blocks?: unknown[] };
        };
        action: { value?: string };
        respond: (m: { replace_original: boolean; text: string; blocks: KnownBlock[] }) => Promise<unknown>;
      }): Promise<void> => {
        await ack();
        const id = action.value;
        if (!id) return;
        // Keep the card the approver saw and swap the buttons for the outcome.
        const card = (body.message?.blocks ?? []) as KnownBlock[];
        const channel = body.container?.channel_id ?? body.channel?.id;
        const ts = body.container?.message_ts ?? body.message?.ts;
        await this.handleDecision({
          userId: body.user.id,
          teamId: body.user.team_id ?? body.team?.id,
          kind,
          id,
          card: { channel, ts },
          finish: async (outcome) => {
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
    app.action(EDIT_ACTION, (async ({ ack, body, action, client }: {
      ack: () => Promise<void>;
      client: WebClient;
      body: { user: { id: string; team_id?: string }; team?: { id?: string }; trigger_id: string; channel?: { id: string }; container?: { channel_id?: string; message_ts?: string }; message?: { ts?: string } };
      action: { value?: string };
    }): Promise<void> => {
      await ack();
      if (!action.value) return;
      void this.handleEditClick({
        userId: body.user.id,
        teamId: body.user.team_id ?? body.team?.id,
        id: action.value,
        channel: body.container?.channel_id ?? body.channel?.id,
        ts: body.container?.message_ts ?? body.message?.ts,
        open: async (view) => {
          await client.views.open({ trigger_id: body.trigger_id, view });
        },
        notice: async (text) => {
          await this.requireApi().post(body.user.id, text);
        },
      }).catch((err) => console.error("Slack edit failed:", err instanceof Error ? err.message : err));
    }) as never);

    // The pop-up was submitted: that is the approval, with the approver's own text.
    app.view(EDIT_VIEW, async ({ ack, body, view }) => {
      const text = (view.state.values["body"]?.["text"]?.value ?? "").trim();
      if (!text || text.length > COMMENT_MAX) {
        await ack({
          response_action: "errors",
          errors: { body: text ? `Please keep it under ${COMMENT_MAX} characters.` : "The comment cannot be empty." },
        });
        return;
      }
      await ack();
      let meta: { id?: string; channel?: string; ts?: string } = {};
      try {
        meta = JSON.parse(view.private_metadata) as typeof meta;
      } catch {
        return;
      }
      if (!meta.id) return;
      void this.handleDecision({
        userId: body.user.id,
        teamId: (body.user as { team_id?: string }).team_id ?? (body as { team?: { id?: string } }).team?.id,
        kind: "approve",
        id: meta.id,
        editedBody: text,
        card: { channel: meta.channel, ts: meta.ts },
        finish: async (outcome, record) => {
          // Without the card or the decided record, fall back to a private message (see handleDecision).
          if (!record || !meta.channel || !meta.ts) throw new Error("card unknown");
          await this.requireApi().update(meta.channel, meta.ts, outcome, decidedBlocks(approvalBlocks(record), outcome));
        },
        notice: async (t) => {
          await this.requireApi().post(body.user.id, t);
        },
      }).catch((err) => console.error("Slack edit decision failed:", err instanceof Error ? err.message : err));
    });

    app.action(APPROVE_ACTION, onClick("approve") as never);
    app.action(REJECT_ACTION, onClick("reject") as never);

    app.error(async (err) => console.error("Slack error:", err.message));

    try {
      await app.start();
      const me = await app.client.auth.test();
      this.botUserId = me.user_id;
      this.homeTeam = me.team_id ?? this.homeTeam;
      console.log(`Slack app connected as @${me.user ?? "app"} in workspace ${me.team ?? "?"}`);
    } catch (err) {
      throw new Error(`Could not connect to Slack: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async stop(): Promise<void> {
    await this.app?.stop();
  }
}
