import { Bot, InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { renderApprovalCard } from "../approvals/render.js";
import type { ApprovalService } from "../approvals/service.js";
import type { Agent } from "../agent/agent.js";
import type { BudgetService } from "../budget/service.js";
import type { GitHubClient } from "../github/client.js";
import type { ActionRecord } from "../store/actions.js";
import { renderDigest } from "../scheduler/digest.js";
import { buildQueue } from "../triage/queue.js";
import {
  decide,
  encodeDecision,
  parseDecision,
  renderBudget,
  renderQueue,
  splitMessage,
} from "./shared.js";

export interface TelegramDeps {
  token: string;
  /** Telegram user ids allowed to chat. Approvers are always allowed too. */
  allowedIds: string[];
  /** Telegram user ids allowed to approve or reject. */
  approverIds: string[];
  agent: Agent;
  approvals: ApprovalService;
  github: Pick<GitHubClient, "listOpenPrs" | "getPr" | "repo">;
  budget: BudgetService;
}

export const telegramActor = (id: number | string): string => `telegram:${id}`;

const HELP = [
  "I help your team decide which pull requests to review first, using live GitHub data.",
  "",
  "Ask me things like:",
  "- What should we review first?",
  "- Why is #12 blocked?",
  "- Leave a comment on #12 asking the author to fix CI (an approver must approve it first)",
  "",
  "Commands:",
  "/queue - ranked review queue (no AI credit used)",
  "/pending - actions waiting for approval",
  "/digest - the morning digest, on demand",
  "/budget - AI budget status",
].join("\n");

export class TelegramChannel {
  readonly bot: Bot;
  private readonly allowed: Set<string>;
  private readonly approvers: Set<string>;
  private readonly busy = new Set<string>();

  constructor(private readonly d: TelegramDeps) {
    this.bot = new Bot(d.token);
    this.approvers = new Set(d.approverIds);
    this.allowed = new Set([...d.allowedIds, ...d.approverIds]);
    this.wire();
  }

  isApprover(actorId: string): boolean {
    return this.approvers.has(actorId.replace(/^telegram:/, ""));
  }

  async start(): Promise<void> {
    await this.bot.api.setMyCommands([
      { command: "queue", description: "Ranked review queue" },
      { command: "pending", description: "Actions waiting for approval" },
      { command: "digest", description: "Morning digest on demand" },
      { command: "budget", description: "AI budget status" },
      { command: "help", description: "What I can do" },
    ]);
    // Long polling: no public webhook URL needed. Do not run two instances with the same token.
    void this.bot.start({
      drop_pending_updates: true,
      onStart: (me) => console.log(`Telegram bot @${me.username} is running`),
    });
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  /** Send plain text to a chat (digest, budget alerts). Long text is split. */
  async send(chatId: string | number, text: string): Promise<void> {
    for (const part of splitMessage(text)) await this.bot.api.sendMessage(chatId, part);
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
    let delivered = 0;
    for (const id of this.approvers) {
      try {
        await this.bot.api.sendMessage(id, renderApprovalCard(record), {
          reply_markup: this.keyboard(record.id),
        });
        delivered += 1;
      } catch (err) {
        console.error(`Could not send approval card to ${id}:`, err instanceof Error ? err.message : err);
      }
    }
    return delivered;
  }

  private keyboard(id: string): InlineKeyboard {
    return new InlineKeyboard()
      .text("Approve and post", encodeDecision("approve", id))
      .text("Reject", encodeDecision("reject", id));
  }

  private wire(): void {
    const { bot } = this;

    // Gate: private chats from allow-listed users only.
    bot.use(async (ctx, next) => {
      const from = ctx.from;
      if (!from || ctx.chat?.type !== "private") return;
      if (!this.allowed.has(String(from.id))) {
        if (ctx.message) {
          await ctx.reply(`You are not on the access list. Your Telegram id is ${from.id}; send it to the owner to be added.`);
        } else if (ctx.callbackQuery) {
          await ctx.answerCallbackQuery({ text: "Not allowed.", show_alert: true });
        }
        return;
      }
      await next();
    });

    bot.command(["start", "help"], (ctx) => ctx.reply(HELP));

    bot.command("queue", (ctx) =>
      this.guarded(ctx, async () => {
        await ctx.replyWithChatAction("typing");
        try {
          await this.reply(ctx, renderQueue(await buildQueue(this.d.github)));
        } catch (err) {
          await ctx.reply(`I couldn't load the queue: ${err instanceof Error ? err.message : "unknown error"}`);
        }
      }),
    );

    // Same text the scheduled job sends, on demand (also how a tester can see it work).
    bot.command("digest", (ctx) =>
      this.guarded(ctx, async () => {
        await ctx.replyWithChatAction("typing");
        try {
          await this.reply(ctx, renderDigest(await buildQueue(this.d.github)));
        } catch (err) {
          await ctx.reply(`I couldn't build the digest: ${err instanceof Error ? err.message : "unknown error"}`);
        }
      }),
    );

    bot.command("budget", (ctx) => ctx.reply(renderBudget(this.d.budget.summary())));

    bot.command("pending", async (ctx) => {
      const list = this.d.approvals.listPending();
      if (list.length === 0) return ctx.reply("Nothing is waiting for approval.");
      const canDecide = this.isApprover(telegramActor(ctx.from?.id ?? ""));
      for (const a of list) {
        await ctx.reply(renderApprovalCard(a), canDecide ? { reply_markup: this.keyboard(a.id) } : {});
      }
      if (!canDecide) await ctx.reply("You can see these, but only approvers can approve or reject them.");
    });

    bot.on("callback_query:data", (ctx) => this.onDecision(ctx));

    bot.on("message:text", (ctx) => {
      const from = ctx.from;
      const key = String(from.id);
      if (this.busy.has(key)) {
        return ctx.reply("I'm still working on your previous question. One moment.");
      }
      // Not awaited: a slow model call must not block other people's updates (or approvals).
      this.busy.add(key);
      void this.answer(ctx).finally(() => this.busy.delete(key));
    });

    bot.catch((err) => console.error("Telegram handler error:", err.message));
  }

  private async answer(ctx: Context): Promise<void> {
    const from = ctx.from;
    const text = ctx.message?.text;
    if (!from || !text) return;
    try {
      await ctx.replyWithChatAction("typing");
      const actor = telegramActor(from.id);
      const result = await this.d.agent.ask({
        conversationId: `telegram:${ctx.chat?.id}`,
        text,
        actor,
        via: "telegram",
        canPropose: true, // anyone on the access list may *ask*; only approvers can approve
      });
      await this.reply(ctx, result.text);
      for (const record of result.proposed) {
        const n = await this.sendApprovalCards(record);
        await ctx.reply(
          n > 0
            ? `Sent for approval (#${record.id.slice(0, 8)}). Nothing is posted until an approver approves it.`
            : `Created request #${record.id.slice(0, 8)}, but I could not reach any approver on Telegram. It stays pending for 24h and can be approved from the web page. Nothing is posted yet.`,
        );
      }
    } catch (err) {
      console.error("Telegram answer failed:", err instanceof Error ? err.message : err);
      await ctx.reply("Something went wrong on my side. Nothing was changed. Please try again.").catch(() => undefined);
    }
  }

  private async onDecision(ctx: Context): Promise<void> {
    const parsed = parseDecision(ctx.callbackQuery?.data);
    const from = ctx.from;
    if (!parsed || !from) return void (await ctx.answerCallbackQuery());

    const actor = telegramActor(from.id);
    if (!this.isApprover(actor)) {
      return void (await ctx.answerCallbackQuery({ text: "Only approvers can do that.", show_alert: true }));
    }

    await ctx.answerCallbackQuery({ text: parsed.kind === "approve" ? "Posting..." : "Rejecting..." });
    const result = await decide(this.d.approvals, parsed.kind, parsed.id, actor);

    const card = ctx.callbackQuery?.message?.text ?? "";
    try {
      // Remove the buttons and record the outcome on the card itself.
      await ctx.editMessageText(`${card}\n\n=> ${result.text}`, { reply_markup: undefined });
    } catch {
      await ctx.reply(result.text);
    }

    // Tell the person who asked, if it was someone else.
    const requester = result.record?.requestedBy;
    if (requester?.startsWith("telegram:") && requester !== actor) {
      const to = requester.replace("telegram:", "");
      await this.send(to, `Your request #${parsed.id.slice(0, 8)}: ${result.text}`).catch(() => undefined);
    }
  }

  /** Per-user guard for commands that call GitHub heavily. */
  private async guarded(ctx: Context, fn: () => Promise<void>): Promise<void> {
    const key = `cmd:${ctx.from?.id}`;
    if (this.busy.has(key)) {
      await ctx.reply("Still working on your last command.");
      return;
    }
    this.busy.add(key);
    try {
      await fn();
    } finally {
      this.busy.delete(key);
    }
  }

  private async reply(ctx: Context, text: string): Promise<void> {
    for (const part of splitMessage(text)) await ctx.reply(part);
  }
}
