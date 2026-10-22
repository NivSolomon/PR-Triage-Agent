import { describe, expect, it } from "vitest";
import { helpText } from "../src/channels/slack.js";
import { homeBlocks } from "../src/channels/slackHome.js";
import { fillLivePrompt, PROMPT_BANK, SLACK_COMMANDS, SLACK_EXAMPLES, WEB_CHIPS, webPromptGroups } from "../src/prompts/bank.js";
import { APP_JS, INDEX_HTML } from "../src/web/ui.js";

const homeText = () =>
  (homeBlocks({ repo: "acme/app", audience: "requester" }) as unknown as Array<Record<string, unknown>>)
    .flatMap((b) => {
      const t = (b.text as { text?: string } | undefined)?.text;
      return t ? [t] : [];
    })
    .join("\n");

describe("prompt bank", () => {
  it("every prompt is a non-empty line the channels can send as-is", () => {
    for (const g of PROMPT_BANK) {
      expect(g.prompts.length).toBeGreaterThan(0);
      for (const p of g.prompts) {
        expect(p.text.trim().length).toBeGreaterThan(3);
        expect(p.channels.length).toBeGreaterThan(0);
      }
    }
  });

  it("comment prompts ask for a comment on a PR, and limit prompts do not", () => {
    const comment = PROMPT_BANK.find((g) => g.id === "comment")!;
    expect(comment.prompts.every((p) => /leave a comment on #\d+/i.test(p.text))).toBe(true);
    const limits = PROMPT_BANK.find((g) => g.id === "limits")!;
    expect(limits.prompts.some((p) => /^Merge /i.test(p.text))).toBe(true);
  });

  it("Slack Home, /triage help and the website chips all come from the same bank", () => {
    const home = homeText();
    const help = helpText(false);
    for (const e of SLACK_EXAMPLES) {
      expect(home).toContain(e);
      expect(help).toContain(e);
    }
    for (const [cmd] of SLACK_COMMANDS) {
      expect(home).toContain(cmd);
      expect(help).toContain(cmd);
    }
    for (const chip of WEB_CHIPS) expect(APP_JS).toContain(chip);
    expect(INDEX_HTML).toContain('id="promptBank"');
    expect(APP_JS).toMatch(/More prompts/);
    expect(APP_JS).toMatch(/fillPrompt/);
    expect(APP_JS).toMatch(/livePromptNumber/);
    expect(webPromptGroups().some((g) => g.items.some((i) => i.includes("Leave a comment")))).toBe(true);
    expect(webPromptGroups().every((g) => g.items.every((i) => !i.startsWith("/triage")))).toBe(true);
  });

  it("fills the #12 stand-in with a blocked PR from the live queue when one exists", () => {
    const items = [
      { number: 8, state: "needs_review" },
      { number: 5, state: "waiting_on_author" },
    ];
    expect(fillLivePrompt("Why is #12 blocked?", items)).toBe("Why is #5 blocked?");
    expect(fillLivePrompt("What should we review first?", items)).toBe("What should we review first?");
    expect(fillLivePrompt("Why is #12 blocked?", [])).toBe("Why is #12 blocked?");
  });
});
