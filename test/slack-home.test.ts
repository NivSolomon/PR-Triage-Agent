import { describe, expect, it } from "vitest";
import { homeBlocks, homeDeniedBlocks } from "../src/channels/slackHome.js";

// Tests for the Slack Home tab layout.

// All visible text in the blocks (section text and context elements), for easy assertions.
const texts = (blocks: Array<Record<string, unknown>>): string[] =>
  blocks.flatMap((b) => {
    const t = (b.text as { text?: string } | undefined)?.text;
    const els = ((b.elements as Array<{ text?: string }> | undefined) ?? []).map((e) => e.text ?? "");
    return [...(t ? [t] : []), ...els];
  });

describe("homeBlocks", () => {
  const blocks = homeBlocks({ repo: "acme/app", audience: "requester", budgetLevel: "normal", pending: 2 }) as unknown as Array<
    Record<string, unknown>
  >;

  it("fits Slack's limits for a Home view", () => {
    expect(blocks.length).toBeLessThanOrEqual(100);
    for (const t of texts(blocks)) expect(t.length).toBeLessThanOrEqual(3000);
  });

  it("explains how to talk to it, gives examples and lists every command", () => {
    const all = texts(blocks).join("\n");
    expect(all).toMatch(/Messages/);
    expect(all).toMatch(/Try asking/);
    for (const c of ["queue", "pending", "digest", "budget", "help"]) expect(all).toContain(`/triage ${c}`);
  });

  it("states the approval rule so a new user knows nothing is posted by itself", () => {
    expect(texts(blocks).join("\n")).toMatch(/only post a comment after a human approves/);
  });

  it("never lets text become a live Slack mention or link", () => {
    const evil = homeBlocks({ repo: "<!channel>/x", audience: "approver" }) as unknown as Array<Record<string, unknown>>;
    const all = texts(evil).join("\n");
    expect(all).not.toContain("<!channel>");
    expect(all).toContain("&lt;!channel&gt;");
  });

  it("the denied view offers the member id and nothing else", () => {
    const all = texts(homeDeniedBlocks("U0X") as unknown as Array<Record<string, unknown>>).join("\n");
    expect(all).toContain("U0X");
  });
});
