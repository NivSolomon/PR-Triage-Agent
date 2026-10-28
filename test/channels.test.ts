import { describe, expect, it, vi } from "vitest";
import { ApprovalError } from "../src/approvals/service.js";
import {
  decide,
  renderQueue,
  splitMessage,
} from "../src/channels/shared.js";
import type { QueueResult } from "../src/triage/queue.js";

// Tests for helpers shared by all chat channels: queue rendering, decision outcomes and message splitting.

// A queue with one PR that has 5 facts and 1 unknown, so capping can be tested.
const queue = (over: Partial<QueueResult> = {}): QueueResult => ({
  generatedAt: "2026-10-20T12:00:00Z",
  repo: "acme/app",
  items: [
    {
      number: 7,
      title: "Fix login",
      author: "dana",
      requestedReviewers: [],
      sourceUrl: "https://github.com/acme/app/pull/7",
      state: "needs_review",
      score: 80,
      confidence: "medium",
      signals: [1, 2, 3, 4, 5].map((i) => ({ code: `s${i}`, text: `fact ${i}`, weight: 1 })),
      unknowns: ["CI is unknown"],
      recommendation: "Review this next.",
    },
  ],
  failed: [],
  truncated: false,
  ...over,
});

describe("renderQueue", () => {
  it("shows state, confidence, a few facts, the unknowns, and the source link", () => {
    const t = renderQueue(queue());
    expect(t).toContain("#7 Fix login - needs review (score 80, confidence medium)");
    expect(t).toContain("fact 1");
    expect(t).not.toContain("fact 4"); // capped to keep chat messages short
    expect(t).toContain("? CI is unknown");
    expect(t).toContain("https://github.com/acme/app/pull/7");
  });

  it("never hides PRs that could not be analysed, or a cut-off list", () => {
    const t = renderQueue(
      queue({ failed: [{ number: 9, title: "Broken", sourceUrl: "https://x/9", error: "boom" }], truncated: true }),
    );
    expect(t).toMatch(/Could not analyse 1 pull request/);
    expect(t).toContain("boom");
    expect(t).toMatch(/More open pull requests exist/);
  });

  it("says plainly when there is nothing open", () => {
    expect(renderQueue(queue({ items: [] }))).toBe("No open pull requests in acme/app.");
  });
});

describe("decide", () => {
  // Minimal action record with the given status.
  const record = (status: string) => ({ status, prNumber: 7, prUrl: "https://x/7", resultUrl: "https://x/7#c", error: null });

  it("turns an approval into a plain outcome message", async () => {
    const approvals = { approve: vi.fn(async () => record("executed")), reject: vi.fn() };
    const r = await decide(approvals as never, "approve", "id", "slack:U01");
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/Posted the comment on #7/);
  });

  it("explains refusals to the user instead of throwing", async () => {
    const approvals = {
      approve: vi.fn(async () => {
        throw new ApprovalError("not_authorized", "You are not allowed to approve or reject actions.");
      }),
      reject: vi.fn(),
    };
    const r = await decide(approvals as never, "approve", "id", "slack:U09");
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/not allowed/);
  });

  it("does not leak internal errors, and says nothing changed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const approvals = { approve: vi.fn(async () => { throw new Error("SQLITE_CORRUPT: secret path"); }), reject: vi.fn() };
    const r = await decide(approvals as never, "approve", "id", "slack:U01");
    expect(r.text).not.toMatch(/SQLITE|secret/);
    expect(r.text).toMatch(/nothing was changed/i);
  });
});

describe("splitMessage", () => {
  it("keeps short text whole and splits long text on line boundaries within the limit", () => {
    expect(splitMessage("hi")).toEqual(["hi"]);
    const long = Array.from({ length: 100 }, (_, i) => `line ${i} ${"x".repeat(50)}`).join("\n");
    const parts = splitMessage(long, 500);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 500)).toBe(true);
    expect(parts.join("\n")).toBe(long);
  });
});
