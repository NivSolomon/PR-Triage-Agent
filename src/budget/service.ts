import type { DatabaseSync } from "node:sqlite";

/**
 * Monthly budget guard.
 *
 * The budget covers model usage AND hosting, so the model's allowance is
 * `monthlyBudget - hosting`. The agent never goes over silently:
 *
 *   normal   (< 80% of allowance)  full behaviour
 *   economy  (80% .. 100%)         fewer tool rounds, shorter answers, users and the team are told
 *   blocked  (>= 100%, or the next call could not be afforded)
 *                                  no model calls; the deterministic queue still works, and the user is told why
 *
 * A per-user daily cap stops one person (or a looping bot) from eating the whole month.
 */

export type BudgetLevel = "normal" | "economy" | "blocked";

const ECONOMY_RATIO = 0.8;
/** Kept in reserve so one in-flight request cannot push the month over the line. */
const RESERVE_USD = 0.1;

export interface BudgetOptions {
  db: DatabaseSync;
  monthlyBudgetUsd: number;
  hostingUsd: number;
  pricePerMInput: number;
  pricePerMOutput: number;
  /** Max requests one actor may make per day. */
  dailyRequestsPerActor: number;
  now?: () => Date;
}

export interface BudgetSummary {
  month: string;
  monthlyBudgetUsd: number;
  hostingUsd: number;
  llmAllowanceUsd: number;
  spentUsd: number;
  remainingUsd: number;
  /** spent / allowance, 0..1+ */
  ratio: number;
  level: BudgetLevel;
  requests: number;
}

export type Gate =
  | { allowed: true; level: "normal" | "economy"; summary: BudgetSummary }
  | { allowed: false; level: "blocked"; reason: string; message: string; summary: BudgetSummary };

export interface UsageInput {
  actor: string;
  requestId: string;
  purpose: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

const monthKey = (d: Date) => d.toISOString().slice(0, 7);
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/** What the agent needs from the budget guard. The SQLite details stay in BudgetService. */
export interface BudgetPort {
  gate(actor: string): Gate;
  record(u: UsageInput): number;
  summary(): BudgetSummary;
  claimAlert(level: BudgetLevel): boolean;
}

export class BudgetService implements BudgetPort {
  private readonly now: () => Date;

  constructor(private readonly o: BudgetOptions) {
    this.now = o.now ?? (() => new Date());
  }

  get allowanceUsd(): number {
    return Math.max(0, this.o.monthlyBudgetUsd - this.o.hostingUsd);
  }

  costOf(inputTokens: number, outputTokens: number): number {
    return (
      (inputTokens * this.o.pricePerMInput + outputTokens * this.o.pricePerMOutput) / 1_000_000
    );
  }

  summary(): BudgetSummary {
    const month = monthKey(this.now());
    const row = this.o.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS spent, COUNT(DISTINCT request_id) AS requests
           FROM llm_usage WHERE month = ?`,
      )
      .get(month) as { spent: number; requests: number };
    const allowance = this.allowanceUsd;
    const ratio = allowance > 0 ? row.spent / allowance : 1;
    const remaining = allowance - row.spent;
    const level: BudgetLevel =
      remaining <= RESERVE_USD || ratio >= 1 ? "blocked" : ratio >= ECONOMY_RATIO ? "economy" : "normal";
    return {
      month,
      monthlyBudgetUsd: this.o.monthlyBudgetUsd,
      hostingUsd: this.o.hostingUsd,
      llmAllowanceUsd: allowance,
      spentUsd: row.spent,
      remainingUsd: Math.max(0, remaining),
      ratio,
      level,
      requests: row.requests,
    };
  }

  /** Call before starting a user request that will use the model. */
  gate(actor: string): Gate {
    const summary = this.summary();
    if (summary.level === "blocked") {
      return {
        allowed: false,
        level: "blocked",
        reason: "monthly_budget",
        message:
          "The monthly AI budget is used up, so I cannot run new analyses with the model until next month. " +
          "The ranked review queue (/triage queue) still works because it uses no AI credit.",
        summary,
      };
    }
    const today = this.requestsToday(actor);
    if (today >= this.o.dailyRequestsPerActor) {
      return {
        allowed: false,
        level: "blocked",
        reason: "daily_limit",
        message: `You've reached today's limit of ${this.o.dailyRequestsPerActor} requests. It resets at 00:00 UTC. The ranked queue (/triage queue) is still available.`,
        summary,
      };
    }
    return { allowed: true, level: summary.level, summary };
  }

  requestsToday(actor: string): number {
    const row = this.o.db
      .prepare(
        `SELECT COUNT(DISTINCT request_id) AS n FROM llm_usage WHERE day = ? AND actor = ?`,
      )
      .get(dayKey(this.now()), actor) as { n: number };
    return row.n;
  }

  /** Record one model call and return its cost. */
  record(u: UsageInput): number {
    const now = this.now();
    const cost = this.costOf(u.inputTokens, u.outputTokens);
    this.o.db
      .prepare(
        `INSERT INTO llm_usage
           (ts, month, day, actor, request_id, purpose, model, input_tokens, output_tokens, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now.toISOString(),
        monthKey(now),
        dayKey(now),
        u.actor,
        u.requestId,
        u.purpose,
        u.model,
        u.inputTokens,
        u.outputTokens,
        cost,
      );
    return cost;
  }

  /**
   * True exactly once per (month, level). Lets the app warn the team when the budget
   * crosses a threshold without repeating the warning on every request.
   */
  claimAlert(level: BudgetLevel): boolean {
    if (level === "normal") return false;
    const key = `budget_alert:${monthKey(this.now())}:${level}`;
    const res = this.o.db
      .prepare(`INSERT OR IGNORE INTO kv (key, value) VALUES (?, ?)`)
      .run(key, this.now().toISOString());
    return Number(res.changes) === 1;
  }
}

export function renderBudgetAlert(s: BudgetSummary): string {
  const pct = Math.round(s.ratio * 100);
  const money = (n: number) => `$${n.toFixed(2)}`;
  if (s.level === "blocked") {
    return (
      `Budget alert: the AI allowance for ${s.month} is used up (${money(s.spentUsd)} of ${money(s.llmAllowanceUsd)}). ` +
      `AI answers are paused until next month; the ranked queue still works.`
    );
  }
  return (
    `Budget warning: ${pct}% of the AI allowance for ${s.month} is used (${money(s.spentUsd)} of ${money(s.llmAllowanceUsd)}). ` +
    `Switching to economy mode: shorter answers, fewer lookups.`
  );
}
