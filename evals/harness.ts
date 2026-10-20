import { Agent } from "../src/agent/agent.js";
import type { AskResult } from "../src/agent/agent.js";
import type { LlmPort } from "../src/agent/llm.js";
import { OpenAiLlm } from "../src/agent/llm.js";
import { ApprovalService } from "../src/approvals/service.js";
import { BudgetService } from "../src/budget/service.js";
import { ActionRepository } from "../src/store/actions.js";
import { openDatabase } from "../src/store/db.js";
import { NOW, makeFixtureGitHub } from "./fixtures.js";

export const hasLlm = Boolean(process.env.LLM_API_KEY);

export function realLlm(): LlmPort {
  return new OpenAiLlm(
    process.env.LLM_API_KEY ?? "",
    process.env.LLM_BASE_URL ?? "https://api.openai.com/v1",
    process.env.LLM_MODEL ?? "gpt-4o-mini",
  );
}

export interface Rig {
  github: ReturnType<typeof makeFixtureGitHub>;
  agent: Agent;
  budget: BudgetService;
  ask(text: string, opts?: { canPropose?: boolean; actor?: string }): Promise<AskResult>;
}

/** The real agent, real approval service and real budget guard, over fixture GitHub data. */
export function makeRig(llm: LlmPort, budgetOver: { monthlyBudgetUsd?: number } = {}): Rig {
  const db = openDatabase(":memory:");
  const github = makeFixtureGitHub();
  const budget = new BudgetService({
    db,
    monthlyBudgetUsd: budgetOver.monthlyBudgetUsd ?? 50,
    hostingUsd: 7,
    pricePerMInput: 0.15,
    pricePerMOutput: 0.6,
    dailyRequestsPerActor: 1000,
    now: () => NOW,
  });
  const approvals = new ApprovalService({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    github: github as any,
    repo: new ActionRepository(db),
    isApprover: () => false, // nobody approves during evals: any post would be a failure
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agent = new Agent({ llm, tools: { github: github as any, approvals, now: () => NOW }, budget, now: () => NOW });
  let n = 0;
  return {
    github,
    agent,
    budget,
    ask: (text, opts = {}) =>
      agent.ask({
        conversationId: `eval-${++n}`,
        text,
        actor: opts.actor ?? "eval:user",
        via: "web",
        canPropose: opts.canPropose ?? true,
      }),
  };
}

/** PR numbers mentioned as "#123" in a text, in order of first appearance. */
export function mentionedPrs(text: string): number[] {
  const seen: number[] = [];
  for (const m of text.matchAll(/#(\d{1,6})\b/g)) {
    const n = Number(m[1]);
    if (!seen.includes(n)) seen.push(n);
  }
  return seen;
}
