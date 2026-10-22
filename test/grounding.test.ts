import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/agent/agent.js";
import type { LlmPort } from "../src/agent/llm.js";
import { checkGrounding, mentionedNumbers, numbersInToolOutput } from "../src/agent/grounding.js";
import { BudgetService } from "../src/budget/service.js";
import { openDatabase } from "../src/store/db.js";

describe("grounding helpers", () => {
  it("extracts PR numbers from text and from tool JSON", () => {
    expect(mentionedNumbers("see #12, #12 and #7; not 99 or a#b")).toEqual([12, 7]);
    expect(numbersInToolOutput('{"queue":[{"number":101},{"number": 102}],"x":{"prNumber":103}}')).toEqual([101, 102, 103]);
  });

  it("passes answers whose numbers all came from fetched data or the user's own question", () => {
    expect(checkGrounding("#101 first, then #102", [101, 102], "what first?").ungrounded).toEqual([]);
    expect(checkGrounding("About #999: I could not find it.", [], "status of #999?").ungrounded).toEqual([]);
  });

  it("flags a number that was never fetched and appends a visible warning", () => {
    const r = checkGrounding("Review #101 and #555 first.", [101], "what first?");
    expect(r.ungrounded).toEqual([555]);
    expect(r.text).toMatch(/Warning: I mentioned #555/);
    expect(r.text.startsWith("Review #101 and #555 first.")).toBe(true);
  });
});

describe("Agent applies the grounding check", () => {
  it("warns the user and logs when the model invents a PR number", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let call = 0;
    const llm: LlmPort = {
      model: "fake",
      async complete() {
        call += 1;
        return call === 1
          ? { content: null, toolCalls: [{ id: "t", name: "get_review_queue", arguments: "{}" }], usage: { inputTokens: 1, outputTokens: 1 } }
          : { content: "Review #101 first, and #404 too.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const agent = new Agent({
      llm,
      tools: {
        github: {
          repo: "a/b",
          listOpenPrs: async () => [{ number: 101, title: "t", sourceUrl: "u" }] as never,
          getPr: async () => ({ number: 101, title: "t", author: "x", draft: false, createdAt: "2026-10-19T00:00:00Z", readySince: "2026-10-19T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z", labels: [], requestedReviewers: [], baseBranch: "main", headBranch: "fix/ci", headSha: "s", sourceUrl: "u", body: "", additions: 1, deletions: 1, changedFiles: 1, reviewableLines: null, mergeableState: "clean", checks: { total: 1, passing: 1, failing: [], pending: [], sourceUrl: "c" }, reviews: [], recentComments: [], commentCount: 0 }),
        },
        approvals: { propose: vi.fn() } as never,
      },
      budget: new BudgetService({ db: openDatabase(":memory:"), monthlyBudgetUsd: 50, hostingUsd: 7, pricePerMInput: 1, pricePerMOutput: 1, dailyRequestsPerActor: 40 }),
    });
    const res = await agent.ask({ conversationId: "c", text: "what first?", actor: "a", via: "web", canPropose: false });
    expect(res.text).toMatch(/Warning: I mentioned #404/);
    expect(res.text).not.toMatch(/Warning: I mentioned #101/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("404"));
  });
});
