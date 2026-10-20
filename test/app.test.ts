import { describe, expect, it } from "vitest";
import { createApp, makeIsApprover } from "../src/app.js";
import { loadConfig } from "../src/config.js";

describe("makeIsApprover", () => {
  it("accepts only listed telegram approvers; chat access alone is not enough", () => {
    const isApprover = makeIsApprover(
      loadConfig({ APPROVER_TELEGRAM_IDS: "1,2", TELEGRAM_ALLOWED_USER_IDS: "3" }),
    );
    expect(isApprover("telegram:1")).toBe(true);
    expect(isApprover("telegram:3")).toBe(false);
    expect(isApprover("mcp:anything")).toBe(false);
    expect(isApprover("1")).toBe(false);
  });
});

describe("createApp", () => {
  it("fails fast and names every missing secret", () => {
    expect(() => createApp(loadConfig({ DATABASE_PATH: ":memory:" }))).toThrow(
      /GITHUB_TOKEN, GITHUB_REPO, LLM_API_KEY, TELEGRAM_BOT_TOKEN/,
    );
  });
});
