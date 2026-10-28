import { describe, expect, it } from "vitest";
import { toPlainText } from "../src/agent/plain.js";

// toPlainText strips Markdown so replies read cleanly in chat channels that don't render it.
describe("toPlainText", () => {
  it("removes bold, code, headings and markdown links but keeps the URL", () => {
    const out = toPlainText("## Queue\n- **#101 Fix login**\n  see [the PR](https://github.com/a/b/pull/101) and `npm test`");
    expect(out).toBe("Queue\n- #101 Fix login\n  see the PR (https://github.com/a/b/pull/101) and npm test");
  });

  it("leaves PR numbers, snake_case words and bare URLs alone", () => {
    const t = "#101 needs review: unit_tests failing\nhttps://github.com/a/b/pull/101";
    expect(toPlainText(t)).toBe(t);
  });

  it("turns * bullets into - bullets and collapses blank lines", () => {
    expect(toPlainText("* one\n* two\n\n\n\nend")).toBe("- one\n- two\n\nend");
  });

  it("does not mangle multiplication or lone asterisks", () => {
    expect(toPlainText("2 * 3 = 6")).toBe("2 * 3 = 6");
  });
});
