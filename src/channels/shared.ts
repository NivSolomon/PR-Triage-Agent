import { ApprovalError } from "../approvals/service.js";
import type { ApprovalService } from "../approvals/service.js";
import { renderOutcome } from "../approvals/render.js";
import type { BudgetSummary } from "../budget/service.js";
import type { TriageAssessment, TriageState } from "../triage/analyze.js";
import { authorNext, personalView } from "../triage/personal.js";
import type { QueueResult } from "../triage/queue.js";
import type { ActionRecord } from "../store/actions.js";
import { count } from "../text/en.js";

const STATE_LABEL: Record<TriageState, string> = {
  needs_review: "needs review",
  ready_to_merge: "ready to merge",
  waiting_on_author: "waiting on the author",
  draft: "draft",
  unclear: "check CI first",
};

const MAX_FACTS = 3; // facts shown per PR, to keep chat messages short

// One ranked PR as lines: headline, top facts, unknowns ("?"), the next step and the source link.
function renderItem(a: TriageAssessment, rank: number, next: string): string[] {
  const out = [`${rank}. #${a.number} ${a.title} - ${STATE_LABEL[a.state]} (score ${a.score}, confidence ${a.confidence})`];
  for (const s of a.signals.slice(0, MAX_FACTS)) out.push(`   - ${s.text}`);
  for (const u of a.unknowns) out.push(`   ? ${u}`);
  out.push(`   Next: ${next}`, `   ${a.sourceUrl}`, ``);
  return out;
}

/**
 * Plain-text queue, the same for every channel. Plain text on purpose: PR titles are untrusted.
 * With a `viewer` (a known GitHub login) the same ranked list is grouped into what is waiting on them.
 */
export function renderQueue(q: QueueResult, viewer?: { login: string }): string {
  if (q.items.length === 0 && q.failed.length === 0) {
    return `No open pull requests in ${q.repo}.`;
  }
  const lines: string[] = [`Review queue for ${q.repo} (live GitHub data, ${q.generatedAt})`, ``];
  if (viewer) {
    const v = personalView(q.items, viewer.login);
    const section = (title: string, items: TriageAssessment[], next: (a: TriageAssessment) => string): void => {
      if (items.length === 0) return;
      lines.push(`${title} (${items.length}):`, ``);
      items.forEach((a, i) => lines.push(...renderItem(a, i + 1, next(a))));
    };
    lines.push(`Personal view for GitHub user ${viewer.login}.`, ``);
    section("Waiting for your review", v.forYou, (a) => a.recommendation);
    if (v.forYou.length === 0) lines.push(`Nothing is waiting specifically for your review.`, ``);
    section("Your pull requests", v.yours, (a) => authorNext(a.state));
    section("Everyone else's, in queue order", v.others, (a) => a.recommendation);
  } else {
    q.items.forEach((a, i) => lines.push(...renderItem(a, i + 1, a.recommendation)));
  }
  if (q.failed.length > 0) {
    lines.push(`Could not analyse ${count(q.failed.length, "pull request")}:`);
    for (const f of q.failed) lines.push(`   - #${f.number} ${f.title}: ${f.error} ${f.sourceUrl}`);
    lines.push(``);
  }
  if (q.truncated) lines.push(`More open pull requests exist than are shown; only the most recently updated were analysed.`);
  if (q.items.length > 0) lines.push(`Score: higher means review sooner. Confidence: how complete the GitHub data was, not a prediction.`);
  return lines.join("\n").trim();
}

/** Plain-text budget status for /triage budget and similar. */
export function renderBudget(s: BudgetSummary): string {
  const money = (n: number) => `$${n.toFixed(2)}`;
  const pct = Math.round(s.ratio * 100);
  // Show "<1%" instead of a misleading "0%" when something has been spent.
  const pctLabel = pct < 1 && s.spentUsd > 0 ? "<1%" : `${pct}%`;
  return [
    `AI budget for ${s.month}`,
    `Mode: ${s.level}`,
    `Used: ${money(s.spentUsd)} of ${money(s.llmAllowanceUsd)} AI allowance (${pctLabel})`,
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
  /** Approve only: the approver corrected the text before approving. */
  editedBody?: string,
): Promise<DecisionResult> {
  try {
    const record =
      kind === "approve"
        // Pass editedBody only when the approver changed the text; the service records the original separately.
        ? await (editedBody === undefined ? approvals.approve(id, actorId) : approvals.approve(id, actorId, { editedBody }))
        : await approvals.reject(id, actorId);
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
    // A single line longer than the limit is cut, so every part still fits.
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
