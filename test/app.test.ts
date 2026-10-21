import { describe, expect, it } from "vitest";
import { createApp, makeIsApprover } from "../src/app.js";
import { loadConfig } from "../src/config.js";

describe("makeIsApprover", () => {
  it("accepts only listed Slack approvers; chat access alone is not enough", () => {
    const isApprover = makeIsApprover(
      loadConfig({ SLACK_APPROVER_USER_IDS: "U01AAA,U02BBB", SLACK_ALLOWED_USER_IDS: "U03CCC" }),
    );
    expect(isApprover("slack:U01AAA")).toBe(true);
    expect(isApprover("slack:U03CCC")).toBe(false);
    expect(isApprover("mcp:anything")).toBe(false);
    expect(isApprover("U01AAA")).toBe(false);
  });
});

describe("createApp", () => {
  it("fails fast and names every missing secret", () => {
    expect(() => createApp(loadConfig({ DATABASE_PATH: ":memory:" }))).toThrow(
      /GITHUB_TOKEN, GITHUB_REPO, LLM_API_KEY, SLACK_BOT_TOKEN, SLACK_APP_TOKEN/,
    );
  });
});
