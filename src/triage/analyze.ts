import type { PrDetail } from "../github/types.js";

/**
 * Deterministic triage of one pull request.
 *
 * Why not let the model rank? A ranking built from named, checkable signals can be tested,
 * cited and explained; the model's job is to explain it in plain language, not to invent it.
 * Every signal carries the evidence it came from, and the confidence drops when data is missing.
 *
 * HOW THE SCORE WORKS (0-100, higher = review sooner)
 *   score = 50 + a band for the PR's state + small adjustments inside that band.
 *   The bands are 20 apart and the adjustments are capped at +/-9, so the score alone decides the order:
 *   a blocked PR can never outrank one a reviewer can act on, however small or old it is.
 *   The numbers inside a band are judgment calls (nobody has measured them on a real team); each one is
 *   listed in WEIGHTS with its reason, and tests prove the bands cannot overlap.
 *   "Confidence" is NOT how sure we are the order is right. It is how complete the data behind it was.
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
  /** Effect on the review priority score (0 = a fact that does not change the order). */
  weight: number;
}

export interface TriageAssessment {
  number: number;
  title: string;
  author: string;
  sourceUrl: string;
  state: TriageState;
  /** Higher = review sooner. The queue is sorted by this. */
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
  /** Lines changed at or above which a PR is "large". Review quality falls as a change grows, so both are judgment calls. */
  largeLines: 800,
  /** Hours without any update after which a PR counts as stale. */
  staleHours: 24 * 7,
  /** Hours a PR has waited for review before the wait itself becomes a reason to act. */
  longWaitHours: 48,
} as const;

/**
 * Where each state sits on the 0-100 scale (added to a base of 50). 20 apart, so the +/-9 adjustments
 * below can never carry a PR into the next band.
 */
export const BANDS: Record<TriageState, { offset: number; code: string; text: string }> = {
  needs_review: { offset: 40, code: "state_review", text: "Reviewers can act on it now." },
  ready_to_merge: {
    offset: 20,
    code: "state_merge",
    text: "Approved and mergeable: no review work left, so it ranks after PRs that still need a review.",
  },
  unclear: { offset: 0, code: "state_unclear", text: "Its CI status is unknown, so it cannot be ranked with confidence." },
  waiting_on_author: {
    offset: -20,
    code: "state_blocked",
    text: "Blocked on the author, so reviewing it now would be wasted effort.",
  },
  draft: { offset: -40, code: "draft", text: "It is marked as a draft." },
};

/**
 * Adjustments inside a band. Every value is a judgment call, kept small on purpose (see the header).
 * Largest possible total for a PR that can be reviewed: wait 3 + small 2 + green 1 + requested 1 + stale approval 2 = 9.
 * Largest possible penalty for a blocked PR: 3 blockers x 2 + large 2 + behind 1 = 9.
 */
export const WEIGHTS = {
  /** Fairness: nothing should wait forever. 1 point at 2 days, +1 per further 2 days, at most 3. */
  waitMax: 3,
  /** Small changes get reviewed faster and more carefully, and free the author sooner. */
  small: 2,
  large: -2,
  /** Green CI over "no checks": the reviewer can trust the build. */
  ciGreen: 1,
  /** Still running: better to wait for the result than to review twice. */
  ciPending: -2,
  /** Someone was explicitly asked. */
  reviewRequested: 1,
  /** Approved, then new commits arrived: the approval no longer covers the code. It needs a fresh look. */
  staleApproval: 2,
  /** Needs a rebase before it can merge. */
  behind: -1,
  /** Within the blocked band: fewer blockers first. */
  blocker: -2,
} as const;

function hoursBetween(fromIso: string, now: Date): number {
  return Math.max(0, (now.getTime() - new Date(fromIso).getTime()) / HOUR);
}

function describeAge(hours: number): string {
  if (hours < 1) return "less than an hour";
  if (hours < 48) return `${Math.round(hours)} hours`;
  return `${Math.round(hours / 24)} days`;
}

type CiState = "green" | "red" | "pending" | "unknown" | "none";

export function assessPr(pr: PrDetail, now: Date = new Date()): TriageAssessment {
  const signals: Signal[] = [];
  const unknowns: string[] = [];
  const add = (code: string, text: string, weight: number): void => {
    signals.push({ code, text, weight });
  };

  // Lock files and generated code are left out of the size; fall back to the raw total if per-file data is missing.
  const totalLines = pr.additions + pr.deletions;
  const lines = pr.reviewableLines ?? totalLines;
  const skippedLines = pr.reviewableLines === null ? 0 : totalLines - pr.reviewableLines;
  const skippedNote = skippedLines > 0 ? ` (${skippedLines} more lines of lock/generated files not counted)` : "";
  const idleHours = hoursBetween(pr.updatedAt, now);

  // The wait clock starts when the PR became ready for review, not when it was opened as a draft.
  const waitStart = pr.readySince ?? pr.createdAt;
  const waitingHours = hoursBetween(waitStart, now);
  if (pr.readySince === null && !pr.draft) {
    unknowns.push("Could not tell when it was marked ready for review, so the wait is counted from when it was opened.");
  }

  // An approval only counts for the code that was reviewed. A newer commit makes it stale.
  const approvals = pr.reviews.filter((r) => r.state === "APPROVED");
  const currentApprovals = approvals.filter((r) => r.commitId === null || r.commitId === pr.headSha);
  const staleApprovals = approvals.filter((r) => r.commitId !== null && r.commitId !== pr.headSha);
  const changesRequested = pr.reviews.filter((r) => r.state === "CHANGES_REQUESTED");

  // --- CI: unknown is never treated as passing ---
  // A failing check only blocks when it is required to merge (or when we cannot tell).
  const optionalFailing = pr.checks?.optionalFailing ?? [];
  const blockingFailing = (pr.checks?.failing ?? []).filter((n) => !optionalFailing.includes(n));
  let ciState: CiState;
  if (pr.checks === null) {
    ciState = "unknown";
    unknowns.push("CI status could not be fetched, so it is not counted as passing.");
  } else if (blockingFailing.length > 0) {
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
  // "unstable" = only non-required checks are failing, which does not stop a merge.
  const onlyOptionalFailing = optionalFailing.length > 0 && blockingFailing.length === 0;
  const mergeable =
    pr.mergeableState === "clean" ||
    pr.mergeableState === "has_hooks" ||
    (pr.mergeableState === "unstable" && onlyOptionalFailing);
  if (pr.mergeableState === null || pr.mergeableState === "unknown") {
    unknowns.push("GitHub has not computed the merge state (conflicts) yet.");
  }

  // --- state decision ---
  const blocked = changesRequested.length > 0 || conflicts || ciState === "red";
  let state: TriageState;
  if (pr.draft) state = "draft";
  else if (blocked) state = "waiting_on_author";
  // "Ready to merge" is a strong claim: approval of THIS code, green (or no) CI, and GitHub itself says it can merge.
  else if (currentApprovals.length > 0 && (ciState === "green" || ciState === "none") && mergeable) state = "ready_to_merge";
  else if (ciState === "unknown") state = "unclear";
  else state = "needs_review";

  // --- facts and in-band adjustments ---
  if (ciState === "red") {
    add("ci_failing", `CI is failing: ${blockingFailing.join(", ")}.`, WEIGHTS.blocker);
    if (pr.checks && pr.checks.requiredKnown === false) {
      unknowns.push("Could not tell which checks are required to merge, so every failing check is treated as a blocker.");
    }
  } else if (ciState === "green") {
    add(
      "ci_green",
      optionalFailing.length > 0
        ? `All required CI checks passed (optional, not blocking: ${optionalFailing.join(", ")} failing).`
        : `All ${pr.checks?.total} CI checks passed.`,
      WEIGHTS.ciGreen,
    );
  } else if (ciState === "pending") {
    add("ci_pending", `CI is still running: ${pr.checks?.pending.join(", ")}.`, WEIGHTS.ciPending);
  }

  if (changesRequested.length > 0) {
    add(
      "changes_requested",
      `${changesRequested.map((r) => r.reviewer).join(", ")} requested changes; the next move is the author's.`,
      WEIGHTS.blocker,
    );
  }
  if (conflicts) add("conflicts", "It has merge conflicts with the base branch.", WEIGHTS.blocker);
  if (pr.mergeableState === "behind") add("behind", "The branch is behind its base branch.", WEIGHTS.behind);

  if (currentApprovals.length > 0) {
    add("approved", `Approved by ${currentApprovals.map((r) => r.reviewer).join(", ")}.`, 0);
    if (state === "needs_review" && pr.mergeableState === "blocked") {
      add(
        "merge_blocked",
        "GitHub reports it cannot be merged yet (often another required approval or check is missing).",
        0,
      );
    }
  } else if (!pr.draft) {
    add("no_approval", "It has no approvals yet.", 0);
  }
  if (staleApprovals.length > 0 && !pr.draft) {
    add(
      "stale_approval",
      `${staleApprovals.map((r) => r.reviewer).join(", ")} approved an earlier version; new commits were pushed since, so it needs a fresh look.`,
      WEIGHTS.staleApproval,
    );
  }

  if (!pr.draft) {
    if (waitingHours >= THRESHOLDS.longWaitHours) {
      const bonus = Math.min(WEIGHTS.waitMax, 1 + Math.floor((waitingHours - THRESHOLDS.longWaitHours) / 48));
      add("long_wait", `It has been waiting for review for ${describeAge(waitingHours)}.`, bonus);
    }
    // Idle for a long time is a prompt to decide, not a reason to rank it lower or higher.
    if (idleHours >= THRESHOLDS.staleHours) {
      add("stale", `No activity for ${describeAge(idleHours)}; it may need a decision to close or revive it.`, 0);
    }
  }

  if (lines <= THRESHOLDS.smallLines) {
    add("small", `Small change: ${lines} lines in ${pr.changedFiles} file(s)${skippedNote}, quick to review.`, WEIGHTS.small);
  } else if (lines >= THRESHOLDS.largeLines) {
    add("large", `Large change: ${lines} lines in ${pr.changedFiles} file(s)${skippedNote}; plan a longer review.`, WEIGHTS.large);
  }

  if (pr.requestedReviewers.length > 0 && !pr.draft) {
    add("review_requested", `Review requested from ${pr.requestedReviewers.join(", ")}.`, WEIGHTS.reviewRequested);
  }

  // The state band goes last so the first few facts shown in chat are real facts, not the band.
  const band = BANDS[state];
  add(band.code, band.text, band.offset);

  const score = Math.max(0, Math.min(100, Math.round(50 + signals.reduce((sum, s) => sum + s.weight, 0))));

  // --- confidence: lower whenever an input to the decision is missing ---
  let confidence: Confidence = "high";
  if (
    ciState === "pending" ||
    ciState === "none" ||
    pr.mergeableState === null ||
    pr.mergeableState === "unknown" ||
    (pr.readySince === null && !pr.draft)
  ) {
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
    recommendation: recommend({
      state,
      author: pr.author,
      ci: ciState,
      approvals: currentApprovals.length,
      mergeableState: pr.mergeableState,
      staleDays: idleHours >= THRESHOLDS.staleHours ? Math.round(idleHours / 24) : 0,
    }),
  };
}

function recommend(x: {
  state: TriageState;
  author: string;
  ci: CiState;
  approvals: number;
  mergeableState: string | null;
  staleDays: number;
}): string {
  switch (x.state) {
    case "draft":
      return "Skip for now; the author has not asked for review.";
    case "waiting_on_author":
      return `Do not review yet. Ask ${x.author} to address the blocker (failing CI, requested changes or conflicts) first.`;
    case "ready_to_merge":
      return `Ready to merge: ${x.approvals} approval(s) on the current code, CI is fine and GitHub reports it mergeable.`;
    case "unclear":
      return "Check CI manually before reviewing; its status could not be fetched.";
    case "needs_review": {
      if (x.approvals > 0) {
        if (x.mergeableState === "blocked") {
          return "Approved, but GitHub says it cannot be merged yet (often a missing required approval or check). Check the branch protection rules.";
        }
        if (x.mergeableState === "behind") return "Approved, but the branch is behind its base. Ask the author to update it, then merge.";
        if (x.ci === "pending") return "Approved; wait for CI to finish before merging.";
        return "Approved, but GitHub has not confirmed it can be merged yet. Check again shortly.";
      }
      const stale = x.staleDays > 0 ? ` It has had no activity for ${x.staleDays} days; check it is still wanted.` : "";
      return (
        (x.ci === "pending"
          ? "Reviewable now; CI is still running, so re-check before approving."
          : "Review this next: nothing blocks the reviewer.") + stale
      );
    }
  }
}

/** Queue order. The score already separates the states; the state is a second guard so a future weight change cannot let a blocked PR jump the queue. */
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
