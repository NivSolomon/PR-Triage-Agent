import { describe, expect, it, vi } from "vitest";
import { renderQueue } from "../src/channels/shared.js";
import { runTool } from "../src/agent/tools.js";
import type { ToolContext } from "../src/agent/tools.js";
import type { TriageAssessment, TriageState } from "../src/triage/analyze.js";
import { authorNext, personalView } from "../src/triage/personal.js";
import type { QueueResult } from "../src/triage/queue.js";
import type { PrDetail } from "../src/github/types.js";

const item = (number: number, author: string, state: TriageState, requestedReviewers: string[] = []): TriageAssessment => ({
  number,
  title: `PR ${number}`,
  author,
  requestedReviewers,
  sourceUrl: `https://github.com/acme/app/pull/${number}`,
  state,
  score: 50,
  confidence: "high",
  signals: [{ code: "x", text: `fact ${number}`, weight: 0 }],
  unknowns: [],
  recommendation: `Review #${number}.`,
});

const queue = (items: TriageAssessment[]): QueueResult => ({
  generatedAt: "2026-10-20T12:00:00Z",
  repo: "acme/app",
  items,
  failed: [],
  truncated: false,
});

describe("personalView", () => {
  const items = [
    item(1, "dana", "needs_review", ["lee"]),
    item(2, "sam", "needs_review", ["Lee"]),
    item(3, "lee", "waiting_on_author"),
    item(4, "dana", "waiting_on_author", ["lee"]),
    item(5, "dana", "draft", ["lee"]),
    item(6, "dana", "needs_review"),
  ];
  const v = personalView(items, "lee");

  it("puts review requests first, ignoring letter case, and keeps the queue order", () => {
    expect(v.forYou.map((a) => a.number)).toEqual([1, 2]);
  });

  it("does not ask you to review a draft or something that is waiting on its author", () => {
    expect(v.forYou.map((a) => a.number)).not.toContain(4);
    expect(v.forYou.map((a) => a.number)).not.toContain(5);
  });

  it("lists your own pull requests separately, in any state", () => {
    expect(v.yours.map((a) => a.number)).toEqual([3]);
  });

  it("every PR appears exactly once", () => {
    const all = [...v.forYou, ...v.yours, ...v.others].map((a) => a.number).sort();
    expect(all).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("tells an author what is theirs to do", () => {
    expect(authorNext("waiting_on_author")).toMatch(/Your move/);
    expect(authorNext("needs_review")).toMatch(/Waiting on reviewers/);
  });
});

describe("renderQueue with a viewer", () => {
  const q = queue([item(1, "dana", "needs_review", ["lee"]), item(3, "lee", "waiting_on_author"), item(6, "dana", "needs_review")]);

  it("without a viewer it is the plain ranked list", () => {
    const text = renderQueue(q);
    expect(text).not.toMatch(/==/);
    expect(text.indexOf("#1")).toBeLessThan(text.indexOf("#3"));
  });

  it("with a viewer it groups what is waiting on them, then their own, then the rest", () => {
    const text = renderQueue(q, { login: "lee" });
    expect(text).toMatch(/Waiting for your review \(1\)/);
    expect(text).toMatch(/Your pull requests \(1\)/);
    expect(text).toMatch(/Everyone else's, in queue order \(1\)/);
    expect(text.indexOf("#1 ")).toBeLessThan(text.indexOf("#3 "));
    expect(text.indexOf("#3 ")).toBeLessThan(text.indexOf("#6 "));
    expect(text).toMatch(/Your move: fix the blocker/);
  });

  it("says plainly when nothing is waiting on the viewer", () => {
    expect(renderQueue(queue([item(6, "dana", "needs_review")]), { login: "lee" })).toMatch(
      /Nothing is waiting specifically for your review/,
    );
  });
});

describe("get_review_queue and the asker's identity", () => {
  const detail = (over: Partial<PrDetail>): PrDetail => ({
    number: 1,
    title: "t",
    author: "dana",
    draft: false,
    createdAt: "2026-10-19T00:00:00Z",
    readySince: "2026-10-19T00:00:00Z",
    updatedAt: "2026-10-20T00:00:00Z",
    labels: [],
    requestedReviewers: ["lee"],
    baseBranch: "main",
    headBranch: "fix/ci",
    headSha: "s",
    sourceUrl: "u",
    body: "",
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    reviewableLines: null,
    mergeableState: "clean",
    checks: { total: 1, passing: 1, failing: [], pending: [], sourceUrl: "c" },
    reviews: [],
    recentComments: [],
    commentCount: 0,
    ...over,
  });
  const deps = {
    github: {
      repo: "acme/app",
      listOpenPrs: vi.fn(async () => [{ number: 1, title: "t", sourceUrl: "u" }]),
      getPr: vi.fn(async () => detail({})),
    },
    approvals: {} as never,
  };
  const ctx = (githubLogin?: string): ToolContext => ({ actor: "slack:U1", via: "slack", canPropose: false, githubLogin });

  it("tells the model which PRs are waiting on the asker when their GitHub login is known", async () => {
    const out = JSON.parse(await runTool("get_review_queue", {}, ctx("Lee"), deps as never));
    expect(out.you).toBe("Lee");
    expect(out.queue[0]).toMatchObject({ requestedFromYou: true, writtenByYou: false });
  });

  it("adds nothing about the asker when it does not know who they are", async () => {
    const out = JSON.parse(await runTool("get_review_queue", {}, ctx(), deps as never));
    expect(out.you).toBeUndefined();
    expect(out.queue[0]).not.toHaveProperty("requestedFromYou");
  });
});
