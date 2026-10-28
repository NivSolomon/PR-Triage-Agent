import { describe, expect, it, vi } from "vitest";
import { BANDS, WEIGHTS, assessPr, rankAssessments } from "../src/triage/analyze.js";
import type { TriageState } from "../src/triage/analyze.js";
import { buildQueue } from "../src/triage/queue.js";
import type { GitHubReader } from "../src/github/port.js";
import type { PrDetail } from "../src/github/types.js";

// Tests for triage scoring: PR state, CI, size, waiting time, ranking and the queue.
// Everything is measured against a fixed NOW so results never depend on the real clock.
const NOW = new Date("2026-10-20T12:00:00Z");
// Shorthand for a review entry on a PR (commitId is the commit the review was made on).
const approval = (reviewer: string, state: string, commitId: string | null) => ({ reviewer, state, submittedAt: null, commitId });
// ISO timestamp h hours before NOW.
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

// A healthy, small, green PR; tests override only what they care about.
function pr(overrides: Partial<PrDetail> = {}): PrDetail {
  return {
    number: 1,
    title: "Add feature",
    author: "dana",
    draft: false,
    createdAt: hoursAgo(5),
    readySince: overrides.createdAt ?? hoursAgo(5),
    updatedAt: hoursAgo(2),
    labels: [],
    requestedReviewers: [],
    baseBranch: "main",
    headBranch: "fix/ci",
    headSha: "abc",
    sourceUrl: "https://github.com/acme/app/pull/1",
    body: "",
    additions: 40,
    deletions: 10,
    changedFiles: 3,
    reviewableLines: null,
    mergeableState: "clean",
    checks: { total: 3, passing: 3, failing: [], pending: [], sourceUrl: "https://example/checks" },
    reviews: [],
    recentComments: [],
    commentCount: 0,
    ...overrides,
  };
}

describe("assessPr: required vs optional CI, and size", () => {
  const checks = (over: Partial<NonNullable<PrDetail["checks"]>>) => ({
    total: 3,
    passing: 2,
    failing: ["lint"],
    pending: [],
    sourceUrl: "u",
    ...over,
  });

  it("a failing check that is not required does not block, and is still shown", () => {
    const a = assessPr(pr({ checks: checks({ optionalFailing: ["lint"], requiredKnown: true }) }), NOW);
    expect(a.state).toBe("needs_review");
    expect(a.signals.find((s) => s.code === "ci_green")?.text).toMatch(/optional.*lint/);
    expect(a.signals.some((s) => s.code === "ci_failing")).toBe(false);
  });

  it("a failing required check still blocks, even when an optional one fails too", () => {
    const a = assessPr(
      pr({ checks: checks({ failing: ["lint", "build"], optionalFailing: ["lint"], requiredKnown: true }) }),
      NOW,
    );
    expect(a.state).toBe("waiting_on_author");
    expect(a.signals.find((s) => s.code === "ci_failing")?.text).toBe("CI is failing: build.");
  });

  it("is ready to merge when only an optional check fails and GitHub reports unstable", () => {
    const a = assessPr(
      pr({
        mergeableState: "unstable",
        reviews: [approval("sam", "APPROVED", "abc")],
        checks: checks({ optionalFailing: ["lint"], requiredKnown: true }),
      }),
      NOW,
    );
    expect(a.state).toBe("ready_to_merge");
  });

  it("an unstable PR with a REQUIRED failure is not ready to merge", () => {
    const a = assessPr(
      pr({ mergeableState: "unstable", reviews: [approval("sam", "APPROVED", "abc")], checks: checks({}) }),
      NOW,
    );
    expect(a.state).toBe("waiting_on_author");
  });

  it("says so when it could not tell which checks are required", () => {
    const a = assessPr(pr({ checks: checks({ requiredKnown: false }) }), NOW);
    expect(a.state).toBe("waiting_on_author");
    expect(a.unknowns.join(" ")).toMatch(/required/);
  });

  it("sizes a PR without lock and generated files, and mentions what was left out", () => {
    const a = assessPr(pr({ additions: 4000, deletions: 100, reviewableLines: 30 }), NOW);
    const small = a.signals.find((s) => s.code === "small");
    expect(small?.text).toMatch(/30 lines/);
    expect(small?.text).toMatch(/4070 more lines of lock\/generated/);
  });

  it("uses a real English plural for one line in one file, not file(s)", () => {
    const a = assessPr(pr({ additions: 1, deletions: 0, changedFiles: 1, reviewableLines: 1 }), NOW);
    expect(a.signals.find((s) => s.code === "small")?.text).toBe("Small change: 1 line in 1 file, quick to review.");
    expect(JSON.stringify(a.signals)).not.toMatch(/\(s\)/);
  });

  it("falls back to the raw total when per-file data is unavailable", () => {
    const a = assessPr(pr({ additions: 4000, deletions: 100, reviewableLines: null }), NOW);
    expect(a.signals.some((s) => s.code === "large")).toBe(true);
  });
});

describe("assessPr: state", () => {
  it("a small green PR with no blockers needs review, with high confidence", () => {
    const a = assessPr(pr(), NOW);
    expect(a.state).toBe("needs_review");
    expect(a.confidence).toBe("high");
    expect(a.unknowns).toEqual([]);
  });

  it("failing CI means waiting on the author, and names the failing check", () => {
    const a = assessPr(
      pr({ checks: { total: 2, passing: 1, failing: ["unit-tests"], pending: [], sourceUrl: "u" } }),
      NOW,
    );
    expect(a.state).toBe("waiting_on_author");
    expect(a.signals.find((s) => s.code === "ci_failing")?.text).toContain("unit-tests");
  });

  it("requested changes or conflicts also block", () => {
    expect(
      assessPr(pr({ reviews: [approval("sam", "CHANGES_REQUESTED", "abc")] }), NOW).state,
    ).toBe("waiting_on_author");
    expect(assessPr(pr({ mergeableState: "dirty" }), NOW).state).toBe("waiting_on_author");
  });

  it("drafts are drafts regardless of anything else", () => {
    expect(assessPr(pr({ draft: true }), NOW).state).toBe("draft");
  });

  it("a closed PR is never scored as something to review now", () => {
    const a = assessPr(pr({ state: "closed", title: "WIP: drag cards between columns" }), NOW);
    expect(a.state).not.toBe("needs_review");
    expect(a.score).toBe(0);
    expect(a.recommendation).toMatch(/closed/);
    expect(a.signals.some((s) => s.code === "closed")).toBe(true);
  });

  it("approved on the current code + green + GitHub says clean is ready to merge", () => {
    const a = assessPr(pr({ reviews: [approval("sam", "APPROVED", "abc")] }), NOW);
    expect(a.state).toBe("ready_to_merge");
    expect(a.recommendation).toMatch(/mergeable/);
  });

  it("an approval of an OLDER commit is stale: not ready to merge, and it asks for a fresh look", () => {
    const a = assessPr(pr({ headSha: "new-sha", reviews: [approval("sam", "APPROVED", "old-sha")] }), NOW);
    expect(a.state).toBe("needs_review");
    expect(a.signals.find((s) => s.code === "stale_approval")?.text).toMatch(/earlier version/);
    expect(a.signals.some((s) => s.code === "approved")).toBe(false);
  });

  it("an approval with no known commit still counts (GitHub did not say), but confidence is not claimed beyond the data", () => {
    expect(assessPr(pr({ reviews: [approval("sam", "APPROVED", null)] }), NOW).state).toBe("ready_to_merge");
  });

  it("approved but GitHub says it is blocked (e.g. a second required approval) is NOT ready to merge", () => {
    const a = assessPr(pr({ mergeableState: "blocked", reviews: [approval("sam", "APPROVED", "abc")] }), NOW);
    expect(a.state).toBe("needs_review");
    expect(a.signals.find((s) => s.code === "merge_blocked")).toBeDefined();
    expect(a.recommendation).toMatch(/branch protection/);
  });

  it("approved but the branch is behind is not ready to merge either", () => {
    const a = assessPr(pr({ mergeableState: "behind", reviews: [approval("sam", "APPROVED", "abc")] }), NOW);
    expect(a.state).toBe("needs_review");
    expect(a.recommendation).toMatch(/behind its base/);
  });

  it("approved while GitHub has not computed the merge state is not claimed as ready, and says so", () => {
    const a = assessPr(pr({ mergeableState: null, reviews: [approval("sam", "APPROVED", "abc")] }), NOW);
    expect(a.state).toBe("needs_review");
    expect(a.unknowns.join(" ")).toMatch(/merge state/);
    expect(a.confidence).toBe("medium");
  });
});

describe("assessPr: honesty about missing data", () => {
  it("unknown CI is never treated as passing: low confidence, stated as unknown", () => {
    const a = assessPr(pr({ checks: null }), NOW);
    expect(a.state).toBe("unclear");
    expect(a.confidence).toBe("low");
    expect(a.unknowns.join(" ")).toMatch(/CI status could not be fetched/);
    expect(a.signals.some((s) => s.code === "ci_green")).toBe(false);
  });

  it("pending CI lowers confidence to medium", () => {
    const a = assessPr(
      pr({ checks: { total: 2, passing: 1, failing: [], pending: ["build"], sourceUrl: "u" } }),
      NOW,
    );
    expect(a.confidence).toBe("medium");
  });

  it("no CI checks at all is reported as a gap, not as green", () => {
    const a = assessPr(pr({ checks: { total: 0, passing: 0, failing: [], pending: [], sourceUrl: "u" } }), NOW);
    expect(a.signals.some((s) => s.code === "ci_green")).toBe(false);
    expect(a.unknowns.join(" ")).toMatch(/No CI checks/);
  });
});

describe("assessPr: the wait clock", () => {
  it("counts the wait from when the PR became ready, not from when it was opened as a draft", () => {
    const wasDraft = assessPr(pr({ createdAt: hoursAgo(24 * 14), readySince: hoursAgo(3) }), NOW);
    expect(wasDraft.signals.some((s) => s.code === "long_wait")).toBe(false);
    const waited = assessPr(pr({ createdAt: hoursAgo(24 * 14), readySince: hoursAgo(24 * 5) }), NOW);
    expect(waited.signals.find((s) => s.code === "long_wait")?.text).toMatch(/5 days/);
  });

  it("says so, and lowers confidence, when it cannot tell when the PR became ready", () => {
    const a = assessPr(pr({ createdAt: hoursAgo(24 * 5), readySince: null }), NOW);
    expect(a.unknowns.join(" ")).toMatch(/marked ready for review/);
    expect(a.confidence).toBe("medium");
    expect(a.signals.some((s) => s.code === "long_wait")).toBe(true); // falls back to opened-at
  });

  it("a stale PR is a prompt to decide, not a ranking change", () => {
    const fresh = assessPr(pr({ updatedAt: hoursAgo(2) }), NOW);
    const idle = assessPr(pr({ updatedAt: hoursAgo(24 * 20), createdAt: hoursAgo(5) }), NOW);
    expect(idle.score).toBe(fresh.score);
    expect(idle.signals.find((s) => s.code === "stale")?.weight).toBe(0);
    expect(idle.recommendation).toMatch(/no activity for 20 days/);
  });
});

describe("assessPr: score", () => {
  it("a long wait raises priority", () => {
    const fresh = assessPr(pr(), NOW);
    const old = assessPr(pr({ createdAt: hoursAgo(24 * 5) }), NOW);
    expect(old.score).toBeGreaterThan(fresh.score);
    expect(old.signals.some((s) => s.code === "long_wait")).toBe(true);
  });

  it("large changes rank below small ones, all else equal", () => {
    const small = assessPr(pr({ additions: 20, deletions: 5 }), NOW);
    const large = assessPr(pr({ additions: 1500, deletions: 200 }), NOW);
    expect(small.score).toBeGreaterThan(large.score);
  });

  it("score stays within 0..100", () => {
    const worst = assessPr(
      pr({
        draft: true,
        mergeableState: "dirty",
        updatedAt: hoursAgo(24 * 60),
        additions: 5000,
        checks: { total: 1, passing: 0, failing: ["x"], pending: [], sourceUrl: "u" },
      }),
      NOW,
    );
    expect(worst.score).toBeGreaterThanOrEqual(0);
    expect(worst.score).toBeLessThanOrEqual(100);
  });
});

describe("the score is the order", () => {
  /** Every combination of the inputs that move a score, for each state we can reach. */
  function scoresByState(): Map<TriageState, number[]> {
    const out = new Map<TriageState, number[]>();
    const push = (a: ReturnType<typeof assessPr>) => out.set(a.state, [...(out.get(a.state) ?? []), a.score]);
    const checks = [
      { total: 3, passing: 3, failing: [], pending: [], sourceUrl: "u" },
      { total: 3, passing: 2, failing: ["x"], pending: [], sourceUrl: "u" },
      { total: 3, passing: 2, failing: [], pending: ["x"], sourceUrl: "u" },
      { total: 0, passing: 0, failing: [], pending: [], sourceUrl: "u" },
      null,
    ];
    for (const draft of [false, true])
      for (const c of checks)
        for (const mergeableState of ["clean", "blocked", "behind", "dirty", null])
          for (const lines of [5, 300, 5000])
            for (const waitH of [1, 60, 110, 160, 400])
              for (const reviewers of [[], ["lee"]])
                for (const reviews of [
                  [],
                  [approval("a", "APPROVED", "abc")],
                  [approval("a", "APPROVED", "old")],
                  [approval("a", "CHANGES_REQUESTED", "abc")],
                ])
                  push(
                    assessPr(
                      pr({
                        draft,
                        checks: c,
                        mergeableState,
                        additions: lines,
                        deletions: 0,
                        createdAt: hoursAgo(waitH),
                        readySince: hoursAgo(waitH),
                        requestedReviewers: reviewers,
                        reviews,
                      }),
                      NOW,
                    ),
                  );
    return out;
  }

  it("keeps the bands apart: the lowest score of a better state beats the highest of the next", () => {
    const by = scoresByState();
    const order: TriageState[] = ["needs_review", "ready_to_merge", "unclear", "waiting_on_author", "draft"];
    const present = order.filter((s) => by.has(s));
    expect(present).toEqual(order); // every state was reached by the grid
    for (let i = 0; i < order.length - 1; i++) {
      const better = by.get(order[i] as TriageState) as number[];
      const worse = by.get(order[i + 1] as TriageState) as number[];
      expect(Math.min(...better)).toBeGreaterThan(Math.max(...worse));
    }
  });

  it("keeps the in-band adjustments within the documented +/-9", () => {
    const by = scoresByState();
    for (const [state, scores] of by) {
      const centre = 50 + BANDS[state].offset;
      expect(Math.max(...scores) - centre).toBeLessThanOrEqual(9);
      expect(centre - Math.min(...scores)).toBeLessThanOrEqual(9);
    }
    expect(WEIGHTS.waitMax + WEIGHTS.small + WEIGHTS.ciGreen + WEIGHTS.reviewRequested + WEIGHTS.staleApproval).toBeLessThanOrEqual(9);
  });

  it("sorting by score alone gives the same queue as the queue order", () => {
    const list = [
      assessPr(pr({ number: 1, mergeableState: "dirty" }), NOW),
      assessPr(pr({ number: 2 }), NOW),
      assessPr(pr({ number: 3, draft: true }), NOW),
      assessPr(pr({ number: 4, reviews: [approval("a", "APPROVED", "abc")] }), NOW),
      assessPr(pr({ number: 5, checks: null }), NOW),
      assessPr(pr({ number: 6, additions: 3000, createdAt: hoursAgo(2) }), NOW),
    ];
    const byScore = [...list].sort((a, b) => b.score - a.score || a.number - b.number).map((a) => a.number);
    expect(rankAssessments(list).map((a) => a.number)).toEqual(byScore);
  });

  it("explains the band as a signal, so the score always adds up from 50", () => {
    const a = assessPr(pr({ reviews: [approval("a", "APPROVED", "abc")] }), NOW);
    expect(50 + a.signals.reduce((s, x) => s + x.weight, 0)).toBe(a.score);
    expect(a.signals.some((s) => s.code === "state_merge")).toBe(true);
  });
});

describe("rankAssessments", () => {
  it("puts reviewable PRs before blocked ones even when a blocked one scores higher", () => {
    const blocked = { ...assessPr(pr({ number: 1, mergeableState: "dirty" }), NOW), score: 99 };
    const ready = { ...assessPr(pr({ number: 2 }), NOW), score: 10 };
    expect(rankAssessments([blocked, ready]).map((x) => x.number)).toEqual([2, 1]);
  });
});

describe("buildQueue", () => {
  const summary = (n: number) => ({ number: n, title: `PR ${n}`, sourceUrl: `https://x/${n}` });

  it("keeps going when one PR fails and reports it instead of dropping it", async () => {
    const github = {
      repo: "acme/app",
      listOpenPrs: vi.fn(async () => [summary(1), summary(2)] as never),
      getPr: vi.fn(async (n: number) => {
        if (n === 2) throw new Error("boom");
        return pr({ number: n });
      }),
    };
    const q = await buildQueue(github, { now: NOW });
    expect(q.items.map((i) => i.number)).toEqual([1]);
    expect(q.failed).toEqual([expect.objectContaining({ number: 2, error: "boom" })]);
    expect(q.truncated).toBe(false);
  });

  it("flags truncation when more PRs are open than the limit", async () => {
    const github = {
      repo: "acme/app",
      listOpenPrs: vi.fn(async () => [summary(1), summary(2), summary(3)] as never),
      getPr: vi.fn(async (n: number) => pr({ number: n })),
    };
    const q = await buildQueue(github, { limit: 2, now: NOW });
    expect(q.items).toHaveLength(2);
    expect(q.truncated).toBe(true);
  });

  it("drops a PR that closed between the open list and the detail fetch", async () => {
    const github = {
      repo: "acme/app",
      listOpenPrs: vi.fn(async () => [summary(1), summary(3)] as never),
      getPr: vi.fn(async (n: number) => (n === 3 ? pr({ number: 3, state: "closed" }) : pr({ number: n }))),
    };
    const q = await buildQueue(github, { now: NOW });
    expect(q.items.map((i) => i.number)).toEqual([1]);
    expect(q.failed).toEqual([]);
  });

  it("depends on GitHubReader, not GitHubClient: a stub with no HTTP client is enough", async () => {
    const github: GitHubReader = {
      repo: "acme/app",
      listOpenPrs: async () => [],
      getPr: async () => {
        throw new Error("no PRs, so getPr must not be called");
      },
    };
    const q = await buildQueue(github, { now: NOW });
    expect(q.repo).toBe("acme/app");
    expect(q.items).toEqual([]);
    expect(q.failed).toEqual([]);
  });
});

describe("assessPr: exact threshold boundaries", () => {
  const weightOf = (a: ReturnType<typeof assessPr>, code: string) => a.signals.find((s) => s.code === code)?.weight;
  const sized = (lines: number) => assessPr(pr({ additions: lines, deletions: 0, reviewableLines: null }), NOW);

  it.each([
    [149, "small"],
    [150, "small"], // "at or below" 150 is small
    [151, null],
    [799, null],
    [800, "large"], // "at or above" 800 is large
    [801, "large"],
  ])("%i changed lines gives the %s signal", (lines, code) => {
    const a = sized(lines);
    expect(a.signals.some((s) => s.code === "small")).toBe(code === "small");
    expect(a.signals.some((s) => s.code === "large")).toBe(code === "large");
  });

  it("counts additions and deletions together", () => {
    expect(assessPr(pr({ additions: 100, deletions: 50 }), NOW).signals.some((s) => s.code === "small")).toBe(true);
    expect(assessPr(pr({ additions: 100, deletions: 51 }), NOW).signals.some((s) => s.code === "small")).toBe(false);
  });

  it.each([
    [47.9, undefined],
    [48, 1],
    [95.9, 1],
    [96, 2],
    [143.9, 2],
    [144, 3],
    [24 * 60, 3], // capped at WEIGHTS.waitMax
  ])("waiting %f hours gives a long-wait bonus of %s", (hours, bonus) => {
    const a = assessPr(pr({ createdAt: hoursAgo(hours) }), NOW);
    expect(weightOf(a, "long_wait")).toBe(bonus);
    expect(bonus ?? 0).toBeLessThanOrEqual(WEIGHTS.waitMax);
  });

  it.each([
    [167.9, false],
    [168, true],
    [24 * 30, true],
  ])("no update for %f hours: stale is %s", (hours, stale) => {
    const a = assessPr(pr({ updatedAt: hoursAgo(hours) }), NOW);
    expect(a.signals.some((s) => s.code === "stale")).toBe(stale);
  });

  it("a draft never accumulates a wait bonus, however old it is", () => {
    const a = assessPr(pr({ draft: true, createdAt: hoursAgo(24 * 30) }), NOW);
    expect(a.signals.some((s) => s.code === "long_wait")).toBe(false);
  });

  it("is deterministic: the same PR and the same clock always give the same result", () => {
    const input = pr({ createdAt: hoursAgo(100), reviews: [approval("a", "APPROVED", "abc")] });
    expect(assessPr(input, NOW)).toEqual(assessPr(structuredClone(input), NOW));
  });

  it("never mutates the PR it is given", () => {
    const input = pr({ reviews: [approval("a", "APPROVED", "abc")], requestedReviewers: ["lee"] });
    const before = structuredClone(input);
    assessPr(input, NOW);
    expect(input).toEqual(before);
  });
});

describe("assessPr: dates it cannot read", () => {
  it("an unreadable 'last updated' is reported and lowers confidence, instead of silently looking recent", () => {
    const a = assessPr(pr({ updatedAt: "not-a-date" }), NOW);
    expect(a.unknowns.join(" ")).toMatch(/last updated/);
    expect(a.confidence).toBe("medium");
    expect(a.signals.some((s) => s.code === "stale")).toBe(false);
    expect(Number.isInteger(a.score)).toBe(true);
  });

  it("an unreadable wait start is reported and lowers confidence, instead of silently counting as no wait", () => {
    const a = assessPr(pr({ createdAt: "garbage" }), NOW);
    expect(a.unknowns.join(" ")).toMatch(/started waiting/);
    expect(a.confidence).toBe("medium");
    expect(a.signals.some((s) => s.code === "long_wait")).toBe(false);
    expect(Number.isInteger(a.score)).toBe(true);
  });

  it("a date in the future (clock skew) counts as zero, not as a negative wait", () => {
    const a = assessPr(pr({ updatedAt: hoursAgo(-5), createdAt: hoursAgo(-5) }), NOW);
    expect(a.unknowns).toEqual([]);
    expect(a.signals.some((s) => s.code === "stale" || s.code === "long_wait")).toBe(false);
  });

  it("an unreadable date on a draft does not invent a wait problem (drafts have no wait clock)", () => {
    const a = assessPr(pr({ draft: true, createdAt: "garbage" }), NOW);
    expect(a.unknowns.join(" ")).not.toMatch(/started waiting/);
  });
});
