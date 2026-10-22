import { randomUUID } from "node:crypto";
import { renderBudgetAlert } from "../budget/service.js";
import type { BudgetPort } from "../budget/service.js";
import type { ActionRecord } from "../store/actions.js";
import type { ChatMessage, LlmPort, ToolCall } from "./llm.js";
import { checkGrounding, notFoundNumbers, numbersInToolOutput, stripNotFoundPrUrls } from "./grounding.js";
import { toPlainText } from "./plain.js";
import { t } from "../i18n/catalog.js";
import { systemPrompt } from "./prompt.js";
import { runTool, toolsFor } from "./tools.js";
import type { ToolContext, ToolDeps } from "./tools.js";

export interface AgentOptions {
  llm: LlmPort;
  tools: ToolDeps;
  budget: BudgetPort;
  /** Told once when the budget crosses a threshold (economy / blocked). */
  notifyTeam?: (text: string) => void | Promise<void>;
  now?: () => Date;
}

export interface AskInput {
  /** Groups follow-up questions, e.g. "slack:D01ABC:U01ABC". */
  conversationId: string;
  text: string;
  actor: string;
  via: ToolContext["via"];
  canPropose: boolean;
  /** The asker's GitHub login, if known, so "what should I review?" can be answered for them. */
  githubLogin?: string;
  /** Counted separately in the budget log, e.g. "chat" or "digest". */
  purpose?: string;
}

export interface AskResult {
  text: string;
  /** Actions proposed during this request. The channel must show an approval card for each. */
  proposed: ActionRecord[];
  /** Older pending drafts this person replaced on the same PR. They can no longer be approved. */
  replaced: ActionRecord[];
  /** Why no model call was made, if so. */
  refusedBecause?: "monthly_budget" | "daily_limit" | "too_long" | "model_unavailable";
}

const MAX_INPUT_CHARS = 2000;
const HISTORY_MESSAGES = 6;
const MAX_CONVERSATIONS = 200;

const LIMITS = {
  normal: { rounds: 4, maxTokens: 800 },
  economy: { rounds: 2, maxTokens: 350 },
} as const;

export class Agent {
  private readonly history = new Map<string, { role: "user" | "assistant"; content: string }[]>();
  private readonly now: () => Date;

  constructor(private readonly o: AgentOptions) {
    this.now = o.now ?? (() => new Date());
  }

  async ask(input: AskInput): Promise<AskResult> {
    const text = input.text.trim();
    if (text.length > MAX_INPUT_CHARS) {
      return {
        text: t("agent.tooLong", { length: text.length, limit: MAX_INPUT_CHARS }),
        proposed: [],
        replaced: [],
        refusedBecause: "too_long",
      };
    }

    const gate = this.o.budget.gate(input.actor);
    if (!gate.allowed) {
      await this.maybeAlert();
      return {
        text:
          gate.reason === "daily_limit"
            ? t("agent.daily", { n: gate.message.match(/\d+/)?.[0] ?? "" })
            : t("agent.budget"),
        proposed: [],
        replaced: [],
        refusedBecause: gate.reason as "monthly_budget" | "daily_limit",
      };
    }

    const economy = gate.level === "economy";
    const limits = economy ? LIMITS.economy : LIMITS.normal;
    const requestId = randomUUID();
    const proposed: ActionRecord[] = [];
    const replaced: ActionRecord[] = [];
    const fetched = new Set<number>();
    const missing = new Set<number>();
    const ctx: ToolContext = {
      actor: input.actor,
      via: input.via,
      canPropose: input.canPropose,
      githubLogin: input.githubLogin,
      fetchedPrs: fetched,
      userText: text,
      requireCommentIntent: true,
      onProposed: (a, withdrawn) => {
        proposed.push(a);
        if (withdrawn) for (const w of withdrawn) replaced.push(w);
      },
    };
    const specs = toolsFor(ctx);

    const prior = this.history.get(input.conversationId) ?? [];
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt({ repo: this.o.tools.github.repo, now: this.now(), economy, canPropose: input.canPropose }) },
      ...prior,
      { role: "user", content: text },
    ];

    let answer: string | null = null;
    try {
      for (let round = 1; round <= limits.rounds && answer === null; round += 1) {
        const lastRound = round === limits.rounds;
        const res = await this.o.llm.complete({
          messages,
          // On the last round no tools are offered, which forces a written answer.
          tools: lastRound ? [] : specs,
          maxTokens: limits.maxTokens,
        });
        this.o.budget.record({
          actor: input.actor,
          requestId,
          purpose: input.purpose ?? "chat",
          model: this.o.llm.model,
          inputTokens: res.usage.inputTokens,
          outputTokens: res.usage.outputTokens,
        });

        if (res.toolCalls.length === 0) {
          answer = (res.content ?? "").trim() || t("agent.noAnswer");
          break;
        }

        messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls });
        for (const call of res.toolCalls) {
          const output = await this.runCall(call, ctx);
          for (const n of numbersInToolOutput(output)) fetched.add(n);
          for (const n of notFoundNumbers(output)) missing.add(n);
          messages.push({ role: "tool", toolCallId: call.id, content: output });
        }
      }
    } catch (err) {
      console.error("LLM call failed:", err instanceof Error ? err.message : err);
      return {
        text: t("agent.modelDown"),
        proposed,
        replaced,
        refusedBecause: "model_unavailable",
      };
    }

    const plain = toPlainText(
      answer ?? t("agent.outOfSteps"),
    );
    const grounding = checkGrounding(plain, fetched, text);
    if (grounding.ungrounded.length > 0) {
      // The signal to watch in production: a rising count means the model is drifting.
      console.warn(`[grounding] request ${requestId} mentioned PR numbers not in fetched data: ${grounding.ungrounded.join(",")}`);
    }
    const finalText = stripNotFoundPrUrls(grounding.text, missing);
    this.remember(input.conversationId, text, finalText);
    await this.maybeAlert();
    return { text: finalText, proposed, replaced };
  }

  private runCall(call: ToolCall, ctx: ToolContext): Promise<string> {
    let args: unknown;
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
    } catch {
      return Promise.resolve(JSON.stringify({ error: "Tool arguments were not valid JSON." }));
    }
    return runTool(call.name, args, ctx, this.o.tools);
  }

  /** Keep only the plain Q&A text (not tool output) so stale PR data is never replayed as fact. */
  private remember(id: string, user: string, assistant: string): void {
    const list = [...(this.history.get(id) ?? []), { role: "user" as const, content: user }, { role: "assistant" as const, content: assistant }];
    this.history.delete(id); // refresh insertion order
    this.history.set(id, list.slice(-HISTORY_MESSAGES));
    while (this.history.size > MAX_CONVERSATIONS) {
      const oldest = this.history.keys().next().value;
      if (oldest === undefined) break;
      this.history.delete(oldest);
    }
  }

  private async maybeAlert(): Promise<void> {
    const s = this.o.budget.summary();
    if (s.level !== "normal" && this.o.budget.claimAlert(s.level)) {
      try {
        await this.o.notifyTeam?.(renderBudgetAlert(s));
      } catch (err) {
        console.error("Budget alert could not be delivered:", err instanceof Error ? err.message : err);
      }
    }
  }
}
