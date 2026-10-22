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

  it("when SLACK_ALLOW_ALL_MEMBERS, any Slack member may approve; MCP and web readers still cannot", () => {
    const isApprover = makeIsApprover(
      loadConfig({
        SLACK_ALLOW_ALL_MEMBERS: "true",
        SLACK_APPROVER_USER_IDS: "U01AAA",
        WEB_USERS: JSON.stringify({ lee: { key: "reader-key-16chars", role: "reader" } }),
      }),
    );
    expect(isApprover("slack:U09TESTER")).toBe(true);
    expect(isApprover("slack:U01AAA")).toBe(true);
    expect(isApprover("mcp:proposer:abc")).toBe(false);
    expect(isApprover("web:lee")).toBe(false);
    expect(isApprover("U09TESTER")).toBe(false);
  });
});

describe("createApp", () => {
  it("fails fast and names every missing secret", () => {
    expect(() => createApp(loadConfig({ DATABASE_PATH: ":memory:" }))).toThrow(
      /GITHUB_TOKEN, GITHUB_REPO, LLM_API_KEY, SLACK_BOT_TOKEN, SLACK_APP_TOKEN/,
    );
  });
});
