import { describe, expect, it } from "vitest";
import { buildGuide, renderGuideText } from "../src/guide.js";

const all = (g: ReturnType<typeof buildGuide>) => g.sections.flatMap((s) => s.items).join("\n");
const section = (g: ReturnType<typeof buildGuide>, tone: string) => g.sections.filter((s) => s.tone === tone).flatMap((s) => s.items).join("\n");

describe("the user guide", () => {
  it("tells a requester plainly that they cannot approve, and never offers them the approve step", () => {
    const g = buildGuide("requester", { channel: "slack" });
    expect(g.youAre).toMatch(/cannot approve/i);
    expect(section(g, "can")).not.toMatch(/approve or reject a comment request/i);
    expect(all(g)).toMatch(/nothing is posted until an approver approves/i);
  });

  it("tells an approver what they can do and where to do it, in each channel", () => {
    const slack = buildGuide("approver", { channel: "slack" });
    const web = buildGuide("approver", { channel: "web" });
    expect(slack.youAre).toMatch(/APPROVER/);
    expect(section(slack, "can")).toMatch(/approve or reject/i);
    expect(section(slack, "can")).toMatch(/direct message/i);
    expect(section(web, "can")).toMatch(/Approvals panel/);
  });

  it("states what nobody can do, approvers included, and the honest limits of the data", () => {
    for (const audience of ["approver", "requester"] as const) {
      const cannot = section(buildGuide(audience, { channel: "web" }), "cannot");
      expect(cannot).toMatch(/never posts, merges, closes, approves or edits/i);
      expect(cannot).toMatch(/cannot see the code diff or the CI logs/i);
    }
  });

  it("says that MCP clients can never approve", () => {
    expect(all(buildGuide("requester", { channel: "web" }))).toMatch(/MCP[^.]*never approve/i);
  });

  it("renders as plain text with no Markdown a chat app would show as raw symbols", () => {
    const text = renderGuideText(buildGuide("approver", { channel: "slack" }));
    expect(text).not.toMatch(/\*\*|__|#{2,}|\[[^\]]+\]\(/);
    expect(text).toContain("What you can do:");
    expect(text).toContain("What nobody can do, approvers included:");
  });
});
