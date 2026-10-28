import { describe, expect, it } from "vitest";
import {
  FoldedLists,
  LIST_PREVIEW,
  LIST_STEP,
  composeRankedView,
  isMoreRequest,
  moreFooter,
  splitRankedItems,
} from "../src/text/fold-list.js";

// Tests for folding long ranked PR lists ("show more" support).

// Builds an agent-style answer: intro, n numbered PRs (each with indented detail lines), then an outro.
function ranked(n: number, intro = "Here are the details:", outro = "Not ready: none."): string {
  const items = Array.from({ length: n }, (_, i) => {
    const k = i + 1;
    return `${k}. #${k} Title ${k}\n- STATE: Needs review\n- VIEW PR: https://github.com/acme/app/pull/${k}`;
  });
  return [intro, "", ...items, "", outro].join("\n");
}

describe("splitRankedItems", () => {
  it("keeps unindented detail dashes with the numbered PR above them", () => {
    const parts = splitRankedItems(ranked(3));
    expect(parts.intro).toBe("Here are the details:");
    expect(parts.items).toHaveLength(3);
    expect(parts.items[0]).toMatch(/^1\. #1 Title 1/);
    expect(parts.items[0]).toMatch(/STATE: Needs review/);
    expect(parts.items[2]).toMatch(/^3\. #3 Title 3/);
    expect(parts.outro).toBe("Not ready: none.");
  });

  it("treats a section header between two numbered lists as part of the next item", () => {
    const text = [
      "Review queue for acme/app",
      "",
      "Waiting for your review (2):",
      "",
      "1. #8 First",
      "   - CI is green",
      "",
      "Your pull requests (1):",
      "",
      "1. #4 Yours",
    ].join("\n");
    const parts = splitRankedItems(text);
    expect(parts.items).toHaveLength(2);
    expect(parts.items[1]).toMatch(/Your pull requests \(1\):/);
    expect(parts.items[1]).toMatch(/1\. #4 Yours/);
  });
});

describe("composeRankedView", () => {
  it("shows a preview of three, then a footer naming how many are left", () => {
    const parts = splitRankedItems(ranked(10));
    const first = composeRankedView(parts, 0, LIST_PREVIEW);
    expect(first.shown).toBe(3);
    expect(first.remaining).toBe(7);
    expect(first.text).toMatch(/#1 Title 1/);
    expect(first.text).toMatch(/#3 Title 3/);
    expect(first.text).not.toMatch(/#4 Title 4/);
    expect(first.text).not.toMatch(/Not ready/);
    expect(first.text).toContain(moreFooter(7));
  });

  it("reveals the next chunk without repeating the intro, and the outro only at the end", () => {
    const parts = splitRankedItems(ranked(10));
    const second = composeRankedView(parts, LIST_PREVIEW, LIST_STEP);
    expect(second.text).toMatch(/^Next 5:/);
    expect(second.text).not.toMatch(/Here are the details/);
    expect(second.text).toMatch(/#4 Title 4/);
    expect(second.text).toMatch(/#8 Title 8/);
    expect(second.text).not.toMatch(/#9 Title 9/);
    expect(second.remaining).toBe(2);
    expect(second.text).not.toMatch(/Not ready/);

    const last = composeRankedView(parts, 8, LIST_STEP);
    expect(last.text).toMatch(/#9 Title 9/);
    expect(last.text).toMatch(/#10 Title 10/);
    expect(last.text).toMatch(/Not ready: none/);
    expect(last.remaining).toBe(0);
  });
});

describe("isMoreRequest", () => {
  it("accepts short reveal phrases and refuses a real follow-up question", () => {
    expect(isMoreRequest("more")).toBe(true);
    expect(isMoreRequest("Show more")).toBe(true);
    expect(isMoreRequest("show more PRs")).toBe(true);
    expect(isMoreRequest("next")).toBe(true);
    expect(isMoreRequest("tell me more about #8")).toBe(false);
    expect(isMoreRequest("more details on the first one")).toBe(false);
  });
});

describe("FoldedLists", () => {
  it("leaves a short list alone and stores nothing", () => {
    const folded = new FoldedLists();
    const text = ranked(2);
    expect(folded.foldOutgoing("c1", text)).toBe(text);
    expect(folded.has("c1")).toBe(false);
  });

  it("hides the tail and hands it back in chunks on take()", () => {
    const folded = new FoldedLists();
    const preview = folded.foldOutgoing("c1", ranked(10));
    expect(preview).toMatch(/#3 Title 3/);
    expect(preview).not.toMatch(/#4 Title 4/);
    expect(folded.has("c1")).toBe(true);

    const next = folded.take("c1");
    expect(next?.text).toMatch(/#8 Title 8/);
    expect(next?.text).not.toMatch(/#9 Title 9/);

    const last = folded.take("c1");
    expect(last?.text).toMatch(/#10 Title 10/);
    expect(last?.text).toMatch(/Not ready: none/);
    expect(folded.has("c1")).toBe(false);
    expect(folded.take("c1")).toBeUndefined();
  });

  it("a new short answer drops the leftover from the previous list", () => {
    const folded = new FoldedLists();
    folded.foldOutgoing("c1", ranked(8));
    folded.foldOutgoing("c1", "Review #7 first.");
    expect(folded.has("c1")).toBe(false);
  });
});
