import { describe, expect, it } from "vitest";
import { loadConfig, requireConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies defaults when env is empty", () => {
    const c = loadConfig({});
    expect(c.PORT).toBe(3000);
    expect(c.MONTHLY_BUDGET_USD).toBe(50);
    expect(c.TELEGRAM_ALLOWED_USER_IDS).toEqual([]);
    expect(c.MCP_TOKENS).toEqual({});
  });

  it("parses comma separated ids and trims whitespace", () => {
    const c = loadConfig({ APPROVER_TELEGRAM_IDS: " 1, 2 ,,3 " });
    expect(c.APPROVER_TELEGRAM_IDS).toEqual(["1", "2", "3"]);
  });

  it("parses the MCP token map", () => {
    const c = loadConfig({ MCP_TOKENS: '{"a":"reader","b":"approver"}' });
    expect(c.MCP_TOKENS).toEqual({ a: "reader", b: "approver" });
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
