import type { TriageAssessment, TriageState } from "./analyze.js";

/**
 * A personal view over the shared queue. It never changes scores or the global order: it only groups the
 * same ranked list by "what is waiting on me", which needs to know who "me" is (a GitHub login).
 */
export interface PersonalView {
  login: string;
  /** Review requested from you, still worth reviewing now. Keeps the queue order. */
  forYou: TriageAssessment[];
  /** Pull requests you wrote, in any state. */
  yours: TriageAssessment[];
  /** Everything else, in queue order. */
  others: TriageAssessment[];
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A review request only matters while the PR is actually reviewable (not a draft, not waiting on its author). */
const REVIEWABLE: ReadonlySet<TriageState> = new Set(["needs_review", "unclear"]);

export function personalView(items: TriageAssessment[], login: string): PersonalView {
  const view: PersonalView = { login, forYou: [], yours: [], others: [] };
  for (const a of items) {
    if (same(a.author, login)) view.yours.push(a);
    else if (REVIEWABLE.has(a.state) && a.requestedReviewers.some((r) => same(r, login))) view.forYou.push(a);
    else view.others.push(a);
  }
  return view;
}

/** What the author of the PR should do next (the shared recommendation is written for the reviewer). */
export function authorNext(state: TriageState): string {
  switch (state) {
    case "waiting_on_author":
      return "Your move: fix the blocker above, then ask for a re-review.";
    case "ready_to_merge":
      return "Your move: it is approved and mergeable.";
    case "needs_review":
      return "Waiting on reviewers.";
    case "draft":
      return "Still a draft: mark it ready when you want reviews.";
    case "unclear":
      return "Check the CI status first; its result is unknown.";
  }
}
