import { describe, expect, it, vi } from "vitest";
import { renderDigest, runDigest, startDigestSchedule } from "../src/scheduler/digest.js";
import type { TriageAssessment } from "../src/triage/analyze.js";
import type { QueueResult } from "../src/triage/queue.js";

const item = (number: number, state: TriageAssessment["state"], extra: Partial<TriageAssessment> = {}): TriageAssessment => ({
  number,
  title: `PR ${number}`,
  author: "dana",
  requestedReviewers: [],
  sourceUrl: `https://github.com/acme/app/pull/${number}`,
  state,
  score: 50,
  confidence: "high",
  signals: [],
  unknowns: [],
  recommendation: "",
  ...extra,
});

const queue = (items: TriageAssessment[], over: Partial<QueueResult> = {}): QueueResult => ({
  generatedAt: "2026-10-20T05:30:00Z",
  repo: "acme/app",
  items,
  failed: [],
  truncated: false,
  ...over,
});

describe("renderDigest", () => {
  it("lists the top reviewable PRs with links and groups blocked ones separately", () => {
    const t = renderDigest(
      queue([
        item(1, "needs_review", { signals: [{ code: "long_wait", text: "It has been open for 5 days.", weight: 10 }] }),
        item(2, "needs_review"),
        item(3, "needs_review"),
        item(4, "needs_review"),
        item(5, "ready_to_merge"),
        item(6, "waiting_on_author"),
        item(7, "draft"),
      ]),
    );
    expect(t).toContain("Review first (4 waiting)");
    expect(t).toContain("open for 5 days");
    expect(t).toContain("https://github.com/acme/app/pull/1");
    expect(t).toMatch(/and 1 more/);
    expect(t).toContain("Ready to merge");
    expect(t).toContain("Waiting on the author (do not review yet): #6");
    expect(t).toContain("1 draft(s) skipped");
  });

  it("flags low-confidence entries and unknown CI instead of presenting them as certain", () => {
    const t = renderDigest(queue([item(1, "needs_review", { confidence: "medium" }), item(2, "unclear", { confidence: "low" })]));
    expect(t).toContain("[confidence medium]");
    expect(t).toContain("CI status unknown, check by hand: #2");
  });

  it("is honest about empty and partial results", () => {
    expect(renderDigest(queue([]))).toMatch(/No open pull requests/);
    const partial = renderDigest(
      queue([item(1, "needs_review")], { failed: [{ number: 9, title: "x", sourceUrl: "u", error: "e" }], truncated: true }),
    );
    expect(partial).toContain("Could not analyse: #9");
    expect(partial).toContain("More open PRs exist");
  });
});

describe("runDigest", () => {
  const github = (listOpenPrs: () => Promise<never[]>) => ({ repo: "acme/app", listOpenPrs, getPr: vi.fn() });

  it("sends the digest", async () => {
    const send = vi.fn(async () => undefined);
    const r = await runDigest({ github: github(async () => []), send });
    expect(r.ok).toBe(true);
    expect(send).toHaveBeenCalledWith(expect.stringContaining("No open pull requests"));
  });

  it("tells the team when it fails instead of staying silent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const send = vi.fn(async () => undefined);
    const r = await runDigest({
      github: github(async () => {
        throw new Error("GitHub rate limit reached.");
      }),
      send,
    });
    expect(r.ok).toBe(false);
    expect(send).toHaveBeenCalledWith(expect.stringMatching(/could not be built: GitHub rate limit reached/));
  });

  it("does not crash if even the failure notice cannot be delivered", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const send = vi.fn(async () => {
      throw new Error("slack down");
    });
    const r = await runDigest({ github: github(async () => []), send });
    expect(r.ok).toBe(false);
  });
});

describe("startDigestSchedule", () => {
  it("rejects an invalid cron expression at startup", () => {
    expect(() => startDigestSchedule("not a cron", async () => undefined)).toThrow(/not a valid cron/);
  });

  it("accepts a valid one and can be stopped", () => {
    const h = startDigestSchedule("30 8 * * 1-5", async () => undefined);
    expect(() => h.stop()).not.toThrow();
  });
});
