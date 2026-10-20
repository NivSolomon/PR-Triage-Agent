import { describe, expect, it, vi } from "vitest";
import { assessPr, rankAssessments } from "../src/triage/analyze.js";
import { buildQueue } from "../src/triage/queue.js";
import type { PrDetail } from "../src/github/types.js";

const NOW = new Date("2026-10-20T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function pr(overrides: Partial<PrDetail> = {}): PrDetail {
  return {
    number: 1,
    title: "Add feature",
    author: "dana",
    draft: false,
    createdAt: hoursAgo(5),
    updatedAt: hoursAgo(2),
    labels: [],
    requestedReviewers: [],
    baseBranch: "main",
    headSha: "abc",
    sourceUrl: "https://github.com/acme/app/pull/1",
    body: "",
    additions: 40,
    deletions: 10,
    changedFiles: 3,
    mergeableState: "clean",
    checks: { total: 3, passing: 3, failing: [], pending: [], sourceUrl: "https://example/checks" },
    reviews: [],
    recentComments: [],
    commentCount: 0,
    ...overrides,
  };
}

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
      assessPr(pr({ reviews: [{ reviewer: "sam", state: "CHANGES_REQUESTED", submittedAt: null }] }), NOW).state,
    ).toBe("waiting_on_author");
    expect(assessPr(pr({ mergeableState: "dirty" }), NOW).state).toBe("waiting_on_author");
  });

  it("drafts are drafts regardless of anything else", () => {
    expect(assessPr(pr({ draft: true }), NOW).state).toBe("draft");
  });

  it("approved + green is ready to merge", () => {
    const a = assessPr(pr({ reviews: [{ reviewer: "sam", state: "APPROVED", submittedAt: null }] }), NOW);
    expect(a.state).toBe("ready_to_merge");
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
});
