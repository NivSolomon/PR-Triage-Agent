import { randomUUID } from "node:crypto";
import { BudgetService, renderBudgetAlert } from "../budget/service.js";
import type { ActionRecord } from "../store/actions.js";
import type { ChatMessage, LlmPort, ToolCall } from "./llm.js";
import { checkGrounding, numbersInToolOutput } from "./grounding.js";
import { toPlainText } from "./plain.js";
import { systemPrompt } from "./prompt.js";
import { runTool, toolsFor } from "./tools.js";
import type { ToolContext, ToolDeps } from "./tools.js";

export interface AgentOptions {
  llm: LlmPort;
  tools: ToolDeps;
  budget: BudgetService;
  /** Told once when the budget crosses a threshold (economy / blocked). */
  notifyTeam?: (text: string) => void | Promise<void>;
  now?: () => Date;
}

export interface AskInput {
  /** Groups follow-up questions, e.g. "telegram:chat:42". */
  conversationId: string;
  text: string;
  actor: string;
  via: ToolContext["via"];
  canPropose: boolean;
  /** Counted separately in the budget log, e.g. "chat" or "digest". */
  purpose?: string;
}

export interface AskResult {
  text: string;
  /** Actions proposed during this request. The channel must show an approval card for each. */
  proposed: ActionRecord[];
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
        text: `That message is too long (${text.length} characters; the limit is ${MAX_INPUT_CHARS}). Please shorten it.`,
        proposed: [],
        refusedBecause: "too_long",
      };
    }

    const gate = this.o.budget.gate(input.actor);
    if (!gate.allowed) {
      await this.maybeAlert();
      return {
        text: gate.message,
        proposed: [],
        refusedBecause: gate.reason as "monthly_budget" | "daily_limit",
      };
    }

    const economy = gate.level === "economy";
    const limits = economy ? LIMITS.economy : LIMITS.normal;
    const requestId = randomUUID();
    const proposed: ActionRecord[] = [];
    const ctx: ToolContext = {
      actor: input.actor,
      via: input.via,
      canPropose: input.canPropose,
      onProposed: (a) => proposed.push(a),
    };
    const specs = toolsFor(ctx);

    const prior = this.history.get(input.conversationId) ?? [];
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt({ repo: this.o.tools.github.repo, now: this.now(), economy, canPropose: input.canPropose }) },
      ...prior,
      { role: "user", content: text },
    ];

    let answer: string | null = null;
    const fetched = new Set<number>();
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
          answer = (res.content ?? "").trim() || "I could not produce an answer. Please try rephrasing.";
          break;
        }

        messages.push({ role: "assistant", content: res.content, toolCalls: res.toolCalls });
        for (const call of res.toolCalls) {
          const output = await this.runCall(call, ctx);
          for (const n of numbersInToolOutput(output)) fetched.add(n);
          messages.push({ role: "tool", toolCallId: call.id, content: output });
        }
      }
    } catch (err) {
      console.error("LLM call failed:", err instanceof Error ? err.message : err);
      return {
        text: "I couldn't reach the AI model just now, so I can't answer that. Please try again in a minute; /queue still shows the ranked list.",
        proposed,
        refusedBecause: "model_unavailable",
      };
    }

    const plain = toPlainText(
      answer ?? "I ran out of steps before I could answer. Please ask a narrower question.",
    );
    const grounding = checkGrounding(plain, fetched, text);
    if (grounding.ungrounded.length > 0) {
      // The signal to watch in production: a rising count means the model is drifting.
      console.warn(`[grounding] request ${requestId} mentioned PR numbers not in fetched data: ${grounding.ungrounded.join(",")}`);
    }
    const finalText = grounding.text;
    this.remember(input.conversationId, text, finalText);
    await this.maybeAlert();
    return { text: finalText, proposed };
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
