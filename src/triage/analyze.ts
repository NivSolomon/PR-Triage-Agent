import type { PrDetail } from "../github/types.js";

/**
 * Deterministic triage of one pull request.
 *
 * Why not let the model rank? A ranking built from named, checkable signals can be tested,
 * cited and explained; the model's job is to explain it in plain language, not to invent it.
 * Every signal carries the evidence it came from, and the confidence drops when data is missing.
 */

export type TriageState =
  | "ready_to_merge" // approved, CI green, nothing blocking
  | "needs_review" // reviewers can act now
  | "waiting_on_author" // changes requested, CI red or conflicts: reviewing now is wasted effort
  | "draft"
  | "unclear"; // not enough data to say

export type Confidence = "high" | "medium" | "low";

export interface Signal {
  /** Machine name, stable for tests and logs. */
  code: string;
  /** Plain-language fact, phrased so it is true by construction (no guessing). */
  text: string;
  /** Effect on the review priority score. */
  weight: number;
}

export interface TriageAssessment {
  number: number;
  title: string;
  author: string;
  sourceUrl: string;
  state: TriageState;
  /** Higher = review sooner. Only comparable between PRs in the same run. */
  score: number;
  confidence: Confidence;
  signals: Signal[];
  /** What we could not find out. Shown to the user so gaps are never hidden. */
  unknowns: string[];
  /** One sentence the user can act on. */
  recommendation: string;
}

const HOUR = 3_600_000;

export const THRESHOLDS = {
  /** Lines changed (additions + deletions) at or below which a PR is "small". */
  smallLines: 150,
  /** Lines changed above which a PR is "large". */
  largeLines: 800,
  /** Hours without any update after which a PR counts as stale. */
  staleHours: 24 * 7,
  /** Hours a PR has waited before the wait itself becomes a reason to act. */
  longWaitHours: 48,
} as const;

function hoursBetween(fromIso: string, now: Date): number {
  return Math.max(0, (now.getTime() - new Date(fromIso).getTime()) / HOUR);
}

function describeAge(hours: number): string {
  if (hours < 1) return "less than an hour";
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}

export function assessPr(pr: PrDetail, now: Date = new Date()): TriageAssessment {
  const signals: Signal[] = [];
  const unknowns: string[] = [];
  const add = (code: string, text: string, weight: number): void => {
    signals.push({ code, text, weight });
  };

  const lines = pr.additions + pr.deletions;
  const waitingHours = hoursBetween(pr.createdAt, now);
  const idleHours = hoursBetween(pr.updatedAt, now);

  const approvals = pr.reviews.filter((r) => r.state === "APPROVED");
  const changesRequested = pr.reviews.filter((r) => r.state === "CHANGES_REQUESTED");

  // --- CI: unknown is never treated as passing ---
  let ciState: "green" | "red" | "pending" | "unknown" | "none";
  if (pr.checks === null) {
    ciState = "unknown";
    unknowns.push("CI status could not be fetched, so it is not counted as passing.");
  } else if (pr.checks.failing.length > 0) {
    ciState = "red";
  } else if (pr.checks.pending.length > 0) {
    ciState = "pending";
  } else if (pr.checks.total === 0) {
    ciState = "none";
    unknowns.push("No CI checks are reported for this commit, so there is no test signal.");
  } else {
    ciState = "green";
  }

  // --- merge state ---
  const conflicts = pr.mergeableState === "dirty";
  if (pr.mergeableState === null || pr.mergeableState === "unknown") {
    unknowns.push("GitHub has not computed the merge state (conflicts) yet.");
  }

  // --- state decision ---
  let state: TriageState;
  if (pr.draft) state = "draft";
  else if (changesRequested.length > 0 || conflicts || ciState === "red") state = "waiting_on_author";
  else if (approvals.length > 0 && (ciState === "green" || ciState === "none")) state = "ready_to_merge";
  else if (ciState === "unknown") state = "unclear";
  else state = "needs_review";

  // --- signals and score ---
  let score = 50;

  if (pr.draft) add("draft", "It is marked as a draft.", -40);

  if (ciState === "red") {
    add("ci_failing", `CI is failing: ${pr.checks?.failing.join(", ")}.`, -30);
  } else if (ciState === "green") {
    add("ci_green", `All ${pr.checks?.total} CI checks passed.`, 10);
  } else if (ciState === "pending") {
    add("ci_pending", `CI is still running: ${pr.checks?.pending.join(", ")}.`, -5);
  }

  if (changesRequested.length > 0) {
    add(
      "changes_requested",
      `${changesRequested.map((r) => r.reviewer).join(", ")} requested changes; the next move is the author's.`,
      -25,
    );
  }
  if (conflicts) add("conflicts", "It has merge conflicts with the base branch.", -20);
  if (pr.mergeableState === "behind") add("behind", "The branch is behind its base branch.", -3);

  if (approvals.length > 0) {
    add("approved", `Approved by ${approvals.map((r) => r.reviewer).join(", ")}.`, 8);
  } else if (!pr.draft) {
    add("no_approval", "It has no approvals yet.", 5);
  }

  if (!pr.draft) {
    if (waitingHours >= THRESHOLDS.longWaitHours) {
      const bonus = Math.min(20, Math.floor((waitingHours - THRESHOLDS.longWaitHours) / 12) + 8);
      add("long_wait", `It has been open for ${describeAge(waitingHours)}.`, bonus);
    }
    if (idleHours >= THRESHOLDS.staleHours) {
      add("stale", `No activity for ${describeAge(idleHours)}; it may need a decision to close or revive it.`, -10);
    }
  }

  if (lines <= THRESHOLDS.smallLines) {
    add("small", `Small change: ${lines} lines in ${pr.changedFiles} file(s), quick to review.`, 10);
  } else if (lines >= THRESHOLDS.largeLines) {
    add("large", `Large change: ${lines} lines in ${pr.changedFiles} file(s); plan a longer review.`, -8);
  }

  if (pr.requestedReviewers.length > 0 && !pr.draft) {
    add("review_requested", `Review requested from ${pr.requestedReviewers.join(", ")}.`, 6);
  }

  score += signals.reduce((sum, s) => sum + s.weight, 0);
  score = Math.max(0, Math.min(100, Math.round(score)));

  // --- confidence: lower whenever an input to the decision is missing ---
  let confidence: Confidence = "high";
  if (ciState === "pending" || ciState === "none" || pr.mergeableState === null || pr.mergeableState === "unknown") {
    confidence = "medium";
  }
  if (ciState === "unknown") confidence = "low";

  return {
    number: pr.number,
    title: pr.title,
    author: pr.author,
    sourceUrl: pr.sourceUrl,
    state,
    score,
    confidence,
    signals,
    unknowns,
    recommendation: recommend(state, pr, ciState, approvals.length),
  };
}

function recommend(
  state: TriageState,
  pr: PrDetail,
  ci: "green" | "red" | "pending" | "unknown" | "none",
  approvals: number,
): string {
  switch (state) {
    case "draft":
      return "Skip for now; the author has not asked for review.";
    case "waiting_on_author":
      return `Do not review yet. Ask ${pr.author} to address the blocker (failing CI, requested changes or conflicts) first.`;
    case "ready_to_merge":
      return `Ready to merge: ${approvals} approval(s) and no blockers found.`;
    case "needs_review":
      return ci === "pending"
        ? "Reviewable now; CI is still running, so re-check before approving."
        : "Review this next: nothing blocks the reviewer.";
    case "unclear":
      return "Check CI manually before reviewing; its status could not be fetched.";
  }
}

/** Order for the review queue: reviewable PRs first, then by score. */
export function rankAssessments(list: TriageAssessment[]): TriageAssessment[] {
  const order: Record<TriageState, number> = {
    needs_review: 0,
    ready_to_merge: 1,
    unclear: 2,
    waiting_on_author: 3,
    draft: 4,
  };
  return [...list].sort(
    (a, b) => order[a.state] - order[b.state] || b.score - a.score || a.number - b.number,
  );
}
