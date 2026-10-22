import { afterEach, describe, expect, it, vi } from "vitest";
import { describeCron } from "../src/scheduler/describe.js";
import { DIGEST_TASK, renderDigest, runDigest, startDigestSchedule } from "../src/scheduler/digest.js";
import { openDatabase } from "../src/store/db.js";
import { RunRepository } from "../src/store/runs.js";
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
    expect(t).toContain("1 draft skipped");
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
    expect(partial).toContain("More open pull requests exist");
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

describe("describeCron", () => {
  it.each([
    ["30 8 * * 1-5", "Weekdays at 08:30"],
    ["0 9 * * *", "Every day at 09:00"],
    ["0 9 * * 0,6", "Weekends at 09:00"],
    ["0 9 * * 6,0", "Weekends at 09:00"],
    ["5 7 * * 1", "Every Monday at 07:05"],
    ["5 7 * * MON", "Every Monday at 07:05"],
    ["0 8 * * 1,3,5", "Monday, Wednesday and Friday at 08:00"],
    ["0 8 * * 1-3", "Monday to Wednesday at 08:00"],
    ["0 8 * * 7", "Every Sunday at 08:00"],
    ["  30   8 * * 1-5 ", "Weekdays at 08:30"],
  ])("says %s in words", (cron, words) => {
    expect(describeCron(cron)).toBe(words);
  });

  it.each(["*/5 * * * *", "30 8 1 * *", "30 8 * 6 *", "0 8,17 * * 1-5", "0 0 8 * * 1-5", "61 8 * * *", "30 25 * * *", "30 8 * * 5-1", "30 8 * * foo"])(
    "never describes what it cannot say exactly: %s comes back unchanged",
    (cron) => {
      expect(describeCron(cron)).toBe(cron);
    },
  );
});

describe("run log", () => {
  const github = (listOpenPrs: () => Promise<never[]>) => ({ repo: "acme/app", listOpenPrs, getPr: vi.fn() });

  it("records a good run with the exact text that was sent", async () => {
    const runs = new RunRepository(openDatabase(":memory:"));
    const send = vi.fn(async () => undefined);
    await runDigest({ github: github(async () => []), send, runs });
    const [r] = runs.recent(DIGEST_TASK);
    expect(r).toMatchObject({ task: "digest", ok: true, error: null });
    expect(r?.text).toBe((send.mock.calls[0] as unknown as [string])[0]);
    expect(Date.parse(r?.startedAt ?? "")).not.toBeNaN();
  });

  it("records a failed build with the reason and the notice the team saw", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runs = new RunRepository(openDatabase(":memory:"));
    await runDigest({
      github: github(async () => {
        throw new Error("GitHub rate limit reached.");
      }),
      send: async () => undefined,
      runs,
    });
    const [r] = runs.recent(DIGEST_TASK);
    expect(r).toMatchObject({ ok: false, error: "GitHub rate limit reached." });
    expect(r?.text).toMatch(/could not be built/);
  });

  it("records a delivery failure as failed (built, but the team never got it)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runs = new RunRepository(openDatabase(":memory:"));
    await runDigest({
      github: github(async () => []),
      send: async () => {
        throw new Error("slack down");
      },
      runs,
    });
    const [r] = runs.recent(DIGEST_TASK);
    expect(r).toMatchObject({ ok: false, error: "slack down" });
    // Nothing reached the team, so the log keeps the digest that could not be delivered.
    expect(r?.text).toContain("No open pull requests");
  });

  it("a broken log never stops the digest from being sent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const send = vi.fn(async () => undefined);
    const r = await runDigest({
      github: github(async () => []),
      send,
      runs: {
        record: () => {
          throw new Error("disk full");
        },
      },
    });
    expect(r.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("returns newest first and keeps only the latest 60 runs", () => {
    const runs = new RunRepository(openDatabase(":memory:"));
    for (let i = 1; i <= 65; i += 1) {
      runs.record({ task: "digest", startedAt: `t${i}`, finishedAt: `t${i}`, ok: true, error: null, text: `run ${i}` });
    }
    runs.record({ task: "other", startedAt: "x", finishedAt: "x", ok: true, error: null, text: "other task" });
    const all = runs.recent("digest", 1000);
    expect(all).toHaveLength(60);
    expect(all[0]?.text).toBe("run 65");
    expect(all.at(-1)?.text).toBe("run 6");
    expect(runs.recent("other")).toHaveLength(1);
  });
});

describe("startDigestSchedule", () => {
  afterEach(() => vi.useRealTimers());

  it("rejects an invalid cron expression at startup", () => {
    expect(() => startDigestSchedule("not a cron", async () => undefined)).toThrow(/not a valid cron/);
  });

  it("accepts a valid one and can be stopped", () => {
    const h = startDigestSchedule("30 8 * * 1-5", async () => undefined);
    expect(() => h.stop()).not.toThrow();
  });

  it("reports when it fires next", () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 22, 17, 0, 0) }); // Thursday 17:00 local time
    const h = startDigestSchedule("30 8 * * 1-5", async () => undefined);
    const next = h.nextRun();
    h.stop();
    expect(next).not.toBeNull();
    // Thursday evening: the next weekday 08:30 is Friday.
    expect([next?.getDay(), next?.getHours(), next?.getMinutes()]).toEqual([5, 8, 30]);
  });

  it("fires at 08:30 on a weekday, and not before it, and not on a weekend", async () => {
    // Local time on purpose: the schedule uses the server's TZ, so the test must not depend on which one that is.
    vi.useFakeTimers({ now: new Date(2026, 9, 22, 8, 25, 0) }); // Thu 22 Oct 2026, 08:25
    const run = vi.fn(async () => undefined);
    const h = startDigestSchedule("30 8 * * 1-5", run);

    // Jump to a wall-clock time, not "+24 h": the clocks change on 25 Oct in some zones (e.g. Israel),
    // and a day is then 25 hours long. The schedule follows the wall clock, so the test must too.
    const advanceTo = (day: number, hour: number, minute: number) =>
      vi.advanceTimersByTimeAsync(new Date(2026, 9, day, hour, minute, 0).getTime() - Date.now());

    await advanceTo(22, 8, 29);
    expect(run).not.toHaveBeenCalled();

    await advanceTo(22, 8, 31); // Thursday
    expect(run).toHaveBeenCalledTimes(1);

    await advanceTo(23, 8, 31); // Friday: fires
    expect(run).toHaveBeenCalledTimes(2);
    await advanceTo(25, 8, 31); // Saturday and Sunday: nothing
    expect(run).toHaveBeenCalledTimes(2);
    await advanceTo(26, 8, 31); // Monday: fires again
    expect(run).toHaveBeenCalledTimes(3);
    h.stop();
  });

  it("a crashing run is logged and the schedule keeps going", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.useFakeTimers({ now: new Date(2026, 9, 22, 8, 29, 0) });
    const run = vi.fn(async () => {
      throw new Error("boom");
    });
    const h = startDigestSchedule("30 8 * * 1-5", run);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(err).toHaveBeenCalledWith("Scheduled run crashed:", expect.any(Error));
    await vi.advanceTimersByTimeAsync(new Date(2026, 9, 23, 8, 31, 0).getTime() - Date.now()); // next day
    expect(run).toHaveBeenCalledTimes(2);
    h.stop();
  });
});
