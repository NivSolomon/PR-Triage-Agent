import { describe, expect, it } from "vitest";
import { BudgetService, renderBudgetAlert } from "../src/budget/service.js";
import { openDatabase } from "../src/store/db.js";

// Tests for BudgetService: token pricing, spend levels, per-person daily caps and alerts.

// Small round numbers (allowance = $5) keep the maths easy to follow.
// Returns spend(usd) to record a cost and setNow(date) to move the clock.
function setup(over: Partial<ConstructorParameters<typeof BudgetService>[0]> = {}) {
  let now = new Date("2026-10-20T10:00:00Z");
  const db = openDatabase(":memory:");
  const svc = new BudgetService({
    db,
    monthlyBudgetUsd: 10,
    hostingUsd: 5, // allowance = 5
    pricePerMInput: 1,
    pricePerMOutput: 4,
    dailyRequestsPerActor: 3,
    now: () => now,
    ...over,
  });
  let n = 0;
  const spend = (usd: number, actor = "u1", requestId = `r${++n}`) => {
    // cost = tokens * 1/1M  => usd * 1M input tokens
    svc.record({ actor, requestId, purpose: "chat", model: "m", inputTokens: usd * 1_000_000, outputTokens: 0 });
  };
  return { svc, spend, setNow: (d: string) => (now = new Date(d)) };
}

describe("cost", () => {
  it("prices input and output tokens separately", () => {
    const { svc } = setup();
    expect(svc.costOf(1_000_000, 1_000_000)).toBeCloseTo(5);
  });
});

describe("levels", () => {
  it("is normal below 80% of the allowance (hosting is subtracted first)", () => {
    const { svc, spend } = setup();
    expect(svc.allowanceUsd).toBe(5);
    spend(3);
    expect(svc.summary().level).toBe("normal");
    expect(svc.gate("u1").allowed).toBe(true);
  });

  it("switches to economy from 80%, still allowed", () => {
    const { svc, spend } = setup();
    spend(4.2);
    const g = svc.gate("u1");
    expect(g.allowed).toBe(true);
    expect(g.level).toBe("economy");
  });

  it("blocks at 100% with a message that says why and what still works", () => {
    const { svc, spend } = setup();
    spend(5);
    const g = svc.gate("u1");
    expect(g.allowed).toBe(false);
    if (!g.allowed) {
      expect(g.reason).toBe("monthly_budget");
      expect(g.message).toMatch(/budget is used up/);
      expect(g.message).toMatch(/\/triage queue/);
    }
  });

  it("blocks when only the safety reserve is left (cannot afford another call)", () => {
    const { svc, spend } = setup();
    spend(4.95);
    expect(svc.gate("u1").allowed).toBe(false);
  });

  it("a hosting cost at or above the budget leaves no model allowance at all", () => {
    const { svc } = setup({ hostingUsd: 12 });
    expect(svc.allowanceUsd).toBe(0);
    expect(svc.gate("u1").allowed).toBe(false);
  });

  it("starts fresh in a new month", () => {
    const { svc, spend, setNow } = setup();
    spend(5);
    expect(svc.gate("u1").allowed).toBe(false);
    setNow("2026-11-01T00:00:01Z");
    expect(svc.gate("u1").allowed).toBe(true);
    expect(svc.summary().spentUsd).toBe(0);
  });
});

describe("daily cap", () => {
  it("counts requests (not model calls) per actor and resets next day", () => {
    const { svc, spend, setNow } = setup();
    // two model calls belonging to ONE request count once
    spend(0.01, "u1", "same");
    spend(0.01, "u1", "same");
    spend(0.01, "u1", "r2");
    expect(svc.requestsToday("u1")).toBe(2);
    spend(0.01, "u1", "r3");
    const g = svc.gate("u1");
    expect(g.allowed).toBe(false);
    if (!g.allowed) expect(g.reason).toBe("daily_limit");
    expect(svc.gate("u2").allowed).toBe(true); // others unaffected
    setNow("2026-10-21T00:00:01Z");
    expect(svc.gate("u1").allowed).toBe(true);
  });
});

describe("alerts", () => {
  it("fires once per level per month", () => {
    const { svc } = setup();
    expect(svc.claimAlert("normal")).toBe(false);
    expect(svc.claimAlert("economy")).toBe(true);
    expect(svc.claimAlert("economy")).toBe(false);
    expect(svc.claimAlert("blocked")).toBe(true);
  });

  it("renders a readable alert", () => {
    const { svc, spend } = setup();
    spend(4.5);
    expect(renderBudgetAlert(svc.summary())).toMatch(/90%.*economy mode/);
  });
});
