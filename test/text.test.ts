import { describe, expect, it } from "vitest";
import { count } from "../src/text/en.js";

describe("count", () => {
  it("says 1 of a noun without a trailing (s)", () => {
    expect(count(1, "file")).toBe("1 file");
    expect(count(1, "hour")).toBe("1 hour");
    expect(count(1, "draft")).toBe("1 draft");
    expect(count(1, "approval card")).toBe("1 approval card");
  });

  it("says 0 and many with the plural form", () => {
    expect(count(0, "file")).toBe("0 files");
    expect(count(2, "hour")).toBe("2 hours");
    expect(count(3, "approval card")).toBe("3 approval cards");
  });

  it("takes an irregular plural when given one", () => {
    expect(count(1, "pull request", "pull requests")).toBe("1 pull request");
    expect(count(2, "pull request", "pull requests")).toBe("2 pull requests");
    expect(count(1, "more", "more")).toBe("1 more");
    expect(count(2, "more", "more")).toBe("2 more");
  });
});
