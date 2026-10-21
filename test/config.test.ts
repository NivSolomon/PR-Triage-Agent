import { describe, expect, it } from "vitest";
import { loadConfig, requireConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies defaults when env is empty", () => {
    const c = loadConfig({});
    expect(c.PORT).toBe(3000);
    expect(c.MONTHLY_BUDGET_USD).toBe(50);
    expect(c.SLACK_ALLOWED_USER_IDS).toEqual([]);
    expect(c.MCP_TOKENS).toEqual({});
  });

  it("treats blank values (as copied from .env.example) as not set, not as invalid", () => {
    const c = loadConfig({
      GITHUB_REPO: "",
      GITHUB_TOKEN: "",
      WEB_ACCESS_KEY: "",
      WEB_APPROVER_KEY: "  ",
      SLACK_DIGEST_CHANNEL_ID: "",
      PORT: "",
      MCP_TOKENS: "",
    });
    expect(c.GITHUB_REPO).toBeUndefined();
    expect(c.WEB_ACCESS_KEY).toBeUndefined();
    expect(c.PORT).toBe(3000); // blank falls back to the default
    expect(c.MCP_TOKENS).toEqual({});
  });

  it("still rejects a value that is set but wrong", () => {
    expect(() => loadConfig({ WEB_ACCESS_KEY: "short" })).toThrow(/at least 16/);
  });

  it("parses comma separated Slack member ids and trims whitespace", () => {
    const c = loadConfig({ SLACK_APPROVER_USER_IDS: " U01ABC, U02DEF ,,W03GHI " });
    expect(c.SLACK_APPROVER_USER_IDS).toEqual(["U01ABC", "U02DEF", "W03GHI"]);
  });

  it("rejects ids that are not Slack member ids (e.g. leftover numeric Telegram ids)", () => {
    expect(() => loadConfig({ SLACK_APPROVER_USER_IDS: "123456789" })).toThrow(/Slack member id/);
    expect(() => loadConfig({ SLACK_ALLOWED_USER_IDS: "U01ABC, someone" })).toThrow(/Slack member id/);
  });

  it("checks the Slack token prefixes so a swapped pair fails with a clear message", () => {
    expect(() => loadConfig({ SLACK_BOT_TOKEN: "xapp-1-abc" })).toThrow(/xoxb-/);
    expect(() => loadConfig({ SLACK_APP_TOKEN: "xoxb-123" })).toThrow(/xapp-/);
    const c = loadConfig({ SLACK_BOT_TOKEN: "xoxb-123", SLACK_APP_TOKEN: "xapp-1-abc", SLACK_DIGEST_CHANNEL_ID: "C01ABC" });
    expect(c.SLACK_BOT_TOKEN).toBe("xoxb-123");
    expect(c.SLACK_DIGEST_CHANNEL_ID).toBe("C01ABC");
  });

  it("lets the whole workspace chat only when SLACK_ALLOW_ALL_MEMBERS is exactly true; default is off", () => {
    expect(loadConfig({}).SLACK_ALLOW_ALL_MEMBERS).toBe(false);
    expect(loadConfig({ SLACK_ALLOW_ALL_MEMBERS: "" }).SLACK_ALLOW_ALL_MEMBERS).toBe(false);
    expect(loadConfig({ SLACK_ALLOW_ALL_MEMBERS: "true" }).SLACK_ALLOW_ALL_MEMBERS).toBe(true);
    expect(loadConfig({ SLACK_ALLOW_ALL_MEMBERS: "false" }).SLACK_ALLOW_ALL_MEMBERS).toBe(false);
    // A typo must fail loudly, not silently open or close access.
    expect(() => loadConfig({ SLACK_ALLOW_ALL_MEMBERS: "yes" })).toThrow(/true/);
  });

  it("rejects a digest target that is not a channel id", () => {
    expect(() => loadConfig({ SLACK_DIGEST_CHANNEL_ID: "#general" })).toThrow(/channel id/);
  });

  it("parses the MCP token map", () => {
    const a = "a".repeat(16);
    const b = "b".repeat(16);
    const c = loadConfig({ MCP_TOKENS: JSON.stringify({ [a]: "reader", [b]: "proposer" }) });
    expect(c.MCP_TOKENS).toEqual({ [a]: "reader", [b]: "proposer" });
  });

  it("has no MCP role that can approve, and rejects short tokens", () => {
    const t = "t".repeat(16);
    expect(() => loadConfig({ MCP_TOKENS: JSON.stringify({ [t]: "approver" }) })).toThrow(/Invalid configuration/);
    expect(() => loadConfig({ MCP_TOKENS: '{"short":"reader"}' })).toThrow(/Invalid configuration/);
  });

  it("rejects an MCP token with an unknown role", () => {
    expect(() => loadConfig({ MCP_TOKENS: '{"a":"admin"}' })).toThrow(/Invalid configuration/);
  });

  it("rejects a malformed repo name", () => {
    expect(() => loadConfig({ GITHUB_REPO: "not-a-repo" })).toThrow(/owner\/repo/);
  });
});

describe("requireConfig", () => {
  it("throws naming every missing variable", () => {
    const c = loadConfig({});
    expect(() => requireConfig(c, ["GITHUB_TOKEN", "GITHUB_REPO"])).toThrow(
      /GITHUB_TOKEN, GITHUB_REPO/,
    );
  });

  it("returns the values when present", () => {
    const c = loadConfig({ GITHUB_TOKEN: "t", GITHUB_REPO: "a/b" });
    expect(requireConfig(c, ["GITHUB_TOKEN"]).GITHUB_TOKEN).toBe("t");
  });
});
