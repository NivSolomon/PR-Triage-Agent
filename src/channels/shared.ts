import { ApprovalError } from "../approvals/service.js";
import type { ApprovalService } from "../approvals/service.js";
import { renderOutcome } from "../approvals/render.js";
import type { BudgetSummary } from "../budget/service.js";
import type { TriageState } from "../triage/analyze.js";
import type { QueueResult } from "../triage/queue.js";
import type { ActionRecord } from "../store/actions.js";

const STATE_LABEL: Record<TriageState, string> = {
  needs_review: "REVIEW NEXT",
  ready_to_merge: "READY TO MERGE",
  waiting_on_author: "WAITING ON AUTHOR",
  draft: "DRAFT",
  unclear: "CHECK CI FIRST",
};

const MAX_FACTS = 3;

/** Plain-text queue, the same for every channel. Plain text on purpose: PR titles are untrusted. */
export function renderQueue(q: QueueResult): string {
  if (q.items.length === 0 && q.failed.length === 0) {
    return `No open pull requests in ${q.repo}.`;
  }
  const lines: string[] = [`Review queue for ${q.repo} (live GitHub data, ${q.generatedAt})`, ``];
  q.items.forEach((a, i) => {
    lines.push(`${i + 1}. #${a.number} ${a.title} - ${STATE_LABEL[a.state]} (score ${a.score}, confidence ${a.confidence})`);
    for (const s of a.signals.slice(0, MAX_FACTS)) lines.push(`   - ${s.text}`);
    for (const u of a.unknowns) lines.push(`   ? ${u}`);
    lines.push(`   Next: ${a.recommendation}`);
    lines.push(`   ${a.sourceUrl}`, ``);
  });
  if (q.failed.length > 0) {
    lines.push(`Could not analyse ${q.failed.length} PR(s):`);
    for (const f of q.failed) lines.push(`   - #${f.number} ${f.title}: ${f.error} ${f.sourceUrl}`);
    lines.push(``);
  }
  if (q.truncated) lines.push(`More open PRs exist than shown; only the most recently updated were analysed.`);
  if (q.items.length > 0) lines.push(`Score: higher means review sooner. Confidence: how complete the GitHub data was, not a prediction.`);
  return lines.join("\n").trim();
}

export function renderBudget(s: BudgetSummary): string {
  const money = (n: number) => `$${n.toFixed(2)}`;
  return [
    `AI budget for ${s.month}`,
    `Mode: ${s.level}`,
    `Used: ${money(s.spentUsd)} of ${money(s.llmAllowanceUsd)} AI allowance (${Math.round(s.ratio * 100)}%)`,
    `Monthly cap ${money(s.monthlyBudgetUsd)} includes ${money(s.hostingUsd)} hosting`,
    `Requests this month: ${s.requests}`,
  ].join("\n");
}

export type DecisionKind = "approve" | "reject";

export interface DecisionResult {
  ok: boolean;
  text: string;
  record?: ActionRecord;
}

/** Apply a human decision and turn every outcome (including refusals) into a message for that human. */
export async function decide(
  approvals: Pick<ApprovalService, "approve" | "reject">,
  kind: DecisionKind,
  id: string,
  actorId: string,
): Promise<DecisionResult> {
  try {
    const record = kind === "approve" ? await approvals.approve(id, actorId) : await approvals.reject(id, actorId);
    return { ok: record.status === "executed" || record.status === "rejected", text: renderOutcome(record), record };
  } catch (err) {
    if (err instanceof ApprovalError) return { ok: false, text: err.message };
    console.error("Unexpected error while deciding an action:", err);
    return { ok: false, text: "Something went wrong and nothing was changed. Please check the pull request and try again." };
  }
}

/** Split long text on line boundaries to fit a channel's message limit. */
export function splitMessage(text: string, max = 3800): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const piece = line.length > max ? line.slice(0, max) : line;
    if (current.length + piece.length + 1 > max) {
      parts.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n${piece}` : piece;
    }
  }
  if (current) parts.push(current);
  return parts;
}
