import { describe, expect, it } from "vitest";
import { loadConfig, requireConfig } from "../src/config.js";

// Tests for reading environment variables: defaults, trimming, blank values and required secrets.
describe("loadConfig", () => {
  it("applies defaults when env is empty", () => {
    const c = loadConfig({});
    expect(c.PORT).toBe(3000);
    expect(c.MONTHLY_BUDGET_USD).toBe(50);
    expect(c.SLACK_ALLOWED_USER_IDS).toEqual([]);
    expect(c.MCP_TOKENS).toEqual({});
  });

  it("trims leading and trailing whitespace so a copied `KEY= value` still works", () => {
    const c = loadConfig({
      LLM_API_KEY: " sk-test-key ",
      GITHUB_REPO: "  octocat/hello-world\t",
      SLACK_BOT_TOKEN: "  xoxb-123  ",
    });
    expect(c.LLM_API_KEY).toBe("sk-test-key");
    expect(c.GITHUB_REPO).toBe("octocat/hello-world");
    expect(c.SLACK_BOT_TOKEN).toBe("xoxb-123");
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

  it("reads per-person web users and the proxy setting", () => {
    const c = loadConfig({
      WEB_USERS: JSON.stringify({ dana: { key: "dana-personal-key-0123", role: "approver" }, "lee.k": { key: "lee-personal-key-012345", role: "reader" } }),
      TRUST_PROXY: "1",
    });
    expect(c.WEB_USERS).toEqual([
      { name: "dana", key: "dana-personal-key-0123", role: "approver" },
      { name: "lee.k", key: "lee-personal-key-012345", role: "reader" },
    ]);
    expect(c.TRUST_PROXY).toBe(1);
    expect(loadConfig({}).WEB_USERS).toEqual([]);
    expect(loadConfig({}).TRUST_PROXY).toBe(0);
  });

  it("rejects web users that are malformed: short key, unknown role, odd name, repeated key", () => {
    const bad = (v: unknown) => () => loadConfig({ WEB_USERS: JSON.stringify(v) });
    expect(bad({ dana: { key: "short", role: "approver" } })).toThrow(/WEB_USERS/);
    expect(bad({ dana: { key: "dana-personal-key-0123", role: "admin" } })).toThrow(/WEB_USERS/);
    expect(bad({ "Dana Smith": { key: "dana-personal-key-0123", role: "reader" } })).toThrow(/WEB_USERS/);
    expect(
      bad({ a: { key: "same-key-0123456789", role: "reader" }, b: { key: "same-key-0123456789", role: "reader" } }),
    ).toThrow(/WEB_USERS/);
    expect(() => loadConfig({ WEB_USERS: "not json" })).toThrow(/WEB_USERS/);
    expect(() => loadConfig({ TRUST_PROXY: "9" })).toThrow(/TRUST_PROXY/);
  });

  it("parses comma separated Slack member ids and trims whitespace", () => {
    const c = loadConfig({ SLACK_APPROVER_USER_IDS: " U01ABC, U02DEF ,,W03GHI " });
    expect(c.SLACK_APPROVER_USER_IDS).toEqual(["U01ABC", "U02DEF", "W03GHI"]);
  });

  it("rejects ids that are not Slack member ids (e.g. plain numbers)", () => {
    expect(() => loadConfig({ SLACK_APPROVER_USER_IDS: "123456789" })).toThrow(/Slack member id/);
    expect(() => loadConfig({ SLACK_ALLOWED_USER_IDS: "U01ABC, someone" })).toThrow(/Slack member id/);
  });

  it("reads the optional Slack-to-GitHub map", () => {
    expect(loadConfig({}).SLACK_GITHUB_USERS).toEqual({});
    expect(loadConfig({ SLACK_GITHUB_USERS: " U01ABC:octocat , W02DEF:Hub-Bot " }).SLACK_GITHUB_USERS).toEqual({
      U01ABC: "octocat",
      W02DEF: "Hub-Bot",
    });
    expect(() => loadConfig({ SLACK_GITHUB_USERS: "octocat" })).toThrow(/U01ABCDEF:github-login/);
    expect(() => loadConfig({ SLACK_GITHUB_USERS: "U01ABC:not a login" })).toThrow(/github-login/);
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

  it("reads an optional GitHub login on a web user", () => {
    const c = loadConfig({
      WEB_USERS: JSON.stringify({ dana: { key: "dana-personal-key-0123", role: "approver", github: "octocat" } }),
    });
    expect(c.WEB_USERS).toEqual([{ name: "dana", key: "dana-personal-key-0123", role: "approver", github: "octocat" }]);
    expect(() =>
      loadConfig({ WEB_USERS: JSON.stringify({ dana: { key: "dana-personal-key-0123", role: "approver", github: "not a login" } }) }),
    ).toThrow(/WEB_USERS/);
  });

  it("refuses AUTH_MAX_FAILURES=0 when TRUST_PROXY is set (a public host must keep the lockout)", () => {
    expect(() => loadConfig({ TRUST_PROXY: "1", AUTH_MAX_FAILURES: "0" })).toThrow(/AUTH_MAX_FAILURES/);
    expect(loadConfig({ TRUST_PROXY: "0", AUTH_MAX_FAILURES: "0" }).AUTH_MAX_FAILURES).toBe(0);
    expect(loadConfig({ TRUST_PROXY: "1" }).AUTH_MAX_FAILURES).toBe(10);
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
