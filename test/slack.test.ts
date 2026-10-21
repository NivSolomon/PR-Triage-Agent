import { describe, expect, it, vi } from "vitest";
import {
  APPROVE_ACTION,
  REJECT_ACTION,
  SlackChannel,
  approvalBlocks,
  decidedBlocks,
  explainSlackError,
  slackActor,
  slackSafe,
} from "../src/channels/slack.js";
import type { SlackApi } from "../src/channels/slack.js";
import type { ActionRecord } from "../src/store/actions.js";

const record = (over: Partial<ActionRecord> = {}): ActionRecord => ({
  id: "11111111-2222-3333-4444-555555555555",
  kind: "comment",
  prNumber: 7,
  prTitle: "Fix login",
  prUrl: "https://github.com/acme/app/pull/7",
  body: "Please fix CI",
  status: "pending",
  requestedBy: "slack:U0ASKER",
  requestedVia: "slack",
  reason: "CI is failing",
  createdAt: "2026-10-20T10:00:00Z",
  expiresAt: "2026-10-21T10:00:00Z",
  decidedBy: null,
  decidedAt: null,
  resultUrl: null,
  error: null,
  ...over,
});

interface Post {
  channel: string;
  text: string;
  opts?: { threadTs?: string; blocks?: unknown[] };
}

function setup(
  over: { allowed?: string[]; approvers?: string[]; allowAll?: boolean; ask?: () => Promise<unknown>; approvals?: object } = {},
) {
  const posts: Post[] = [];
  const removed: Array<[string, string]> = [];
  let n = 0;
  const api: SlackApi = {
    post: vi.fn(async (channel, text, opts) => {
      posts.push({ channel, text, opts });
      return `ts${++n}`;
    }),
    remove: vi.fn(async (channel, ts) => void removed.push([channel, ts])),
  };
  const agent = {
    ask: vi.fn(over.ask ?? (async () => ({ text: "Review #7 first.", proposed: [] as ActionRecord[] }))),
  };
  const approvals = over.approvals ?? { approve: vi.fn(), reject: vi.fn(), listPending: vi.fn(() => []) };
  const github = { repo: "acme/app", listOpenPrs: vi.fn(async () => []), getPr: vi.fn() };
  const budget = {
    summary: vi.fn(() => ({
      month: "2026-10",
      level: "normal",
      spentUsd: 1,
      llmAllowanceUsd: 43,
      ratio: 0.02,
      monthlyBudgetUsd: 50,
      hostingUsd: 7,
      requests: 3,
    })),
  };
  const channel = new SlackChannel({
    botToken: "xoxb-test",
    appToken: "xapp-test",
    allowedIds: over.allowed ?? ["U0ALICE"],
    allowAllMembers: over.allowAll,
    approverIds: over.approvers ?? ["U0BOSS"],
    agent: agent as never,
    approvals: approvals as never,
    github: github as never,
    budget: budget as never,
    api,
  });
  return { channel, api, posts, removed, agent, approvals: approvals as Record<string, ReturnType<typeof vi.fn>>, github };
}

describe("slackSafe", () => {
  it("defuses mentions, broadcasts and disguised links written by strangers", () => {
    const evil = "<!channel> <@U123> <https://evil.example|Click> & more";
    const safe = slackSafe(evil);
    expect(safe).not.toMatch(/[<>]/);
    expect(safe).toBe("&lt;!channel&gt; &lt;@U123&gt; &lt;https://evil.example|Click&gt; &amp; more");
  });
});

const textOf = (blocks: unknown[]): string[] =>
  (blocks as Array<{ type: string; text?: { text: string } }>).filter((b) => b.type === "section").map((b) => b.text?.text ?? "");
const unescape = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

describe("approvalBlocks", () => {
  it("offers Approve (with a confirmation) and Reject, both carrying only the request id", () => {
    const blocks = approvalBlocks(record());
    const actions = blocks.find((b) => b.type === "actions") as unknown as { elements: Array<Record<string, unknown>> };
    expect(actions.elements.map((e) => e.action_id)).toEqual([APPROVE_ACTION, REJECT_ACTION]);
    expect(actions.elements.every((e) => e.value === record().id)).toBe(true);
    expect(actions.elements[0]).toHaveProperty("confirm");
  });

  it("shows the facts on separate lines and the exact comment in a code block", () => {
    const sections = textOf(approvalBlocks(record({ body: "Line one\nLine two" })));
    const all = sections.join("\n");
    expect(all).toContain("*Action:* post ONE public comment on pull request #7");
    expect(all).toContain("```Line one\nLine two```");
    expect(all).toMatch(/\*Requested by\* slack:U0ASKER via slack/);
  });

  it("defuses a hostile comment and title: no live mention, broadcast or link survives", () => {
    const sections = textOf(
      approvalBlocks(record({ body: "<!channel> <https://evil.example|Click> <@U123>", prTitle: "<!here> urgent" })),
    );
    const all = sections.join("\n");
    expect(all).not.toMatch(/<!|<@|<https?:/);
    expect(all).toContain("&lt;!channel&gt;");
    expect(all).toContain("&lt;!here&gt; urgent");
  });

  it("cannot be broken out of its code block by backticks in the comment", () => {
    const sections = textOf(approvalBlocks(record({ body: "before ``` after" })));
    const body = sections.find((s) => s.includes("Exact comment text"))!;
    const inner = body.slice(body.indexOf("```") + 3, body.lastIndexOf("```"));
    expect(inner).not.toContain("```");
    expect(inner.replace(/\u200b/g, "")).toBe("before ``` after");
  });

  it("never cuts a long comment, even when escaping makes it much longer", () => {
    const body = Array.from({ length: 60 }, (_, i) => `line ${i} <&> ${"y".repeat(40)}`).join("\n") + "\n" + "&".repeat(1500);
    const trimmed = body.slice(0, 2000);
    const sections = textOf(approvalBlocks(record({ body: trimmed })));
    expect(sections.every((s) => s.length <= 3000)).toBe(true);
    const shown = sections
      .filter((s) => s.startsWith("*Exact comment text:*") || s.startsWith("*...continued:*"))
      .map((s) => unescape(s.slice(s.indexOf("```") + 3, s.lastIndexOf("```"))))
      .join("\n");
    expect(shown.replace(/\n/g, "")).toBe(trimmed.replace(/\n/g, ""));
  });

  it("keeps the card and replaces the buttons with the outcome after a decision", () => {
    const card = approvalBlocks(record());
    const blocks = decidedBlocks(card, "Posted the comment");
    expect(blocks.some((b) => b.type === "actions")).toBe(false);
    expect(textOf(blocks).join("\n")).toContain("*Exact comment text:*");
    expect(JSON.stringify(blocks)).toContain("Posted the comment");
  });
});
describe("/triage commands", () => {
  const run = async (s: ReturnType<typeof setup>, userId: string, text: string) => {
    const replies: string[] = [];
    await s.channel.handleCommand({ userId, text, reply: async (t) => void replies.push(t) });
    return replies;
  };

  it("turns away people who are not on the list, telling them their id, and never calls the model", async () => {
    const s = setup();
    const replies = await run(s, "U0STRANGER", "what should we review first?");
    expect(replies.join()).toMatch(/not on the access list/);
    expect(replies.join()).toContain("U0STRANGER");
    expect(s.agent.ask).not.toHaveBeenCalled();
    expect(s.github.listOpenPrs).not.toHaveBeenCalled();
  });

  it("shows help for an empty command or 'help'", async () => {
    const s = setup();
    expect((await run(s, "U0ALICE", "")).join()).toMatch(/\/triage queue/);
    expect((await run(s, "U0ALICE", "help")).join()).toMatch(/\/triage queue/);
  });

  it("queue is deterministic: it reads GitHub and uses no model", async () => {
    const s = setup();
    const replies = await run(s, "U0ALICE", "queue");
    expect(replies.join()).toBe("No open pull requests in acme/app.");
    expect(s.agent.ask).not.toHaveBeenCalled();
  });

  it("budget works without the model", async () => {
    const s = setup();
    expect((await run(s, "U0ALICE", "budget")).join()).toMatch(/AI budget for 2026-10/);
    expect(s.agent.ask).not.toHaveBeenCalled();
  });

  it("treats 'queue' followed by more words as a question, not as the command", async () => {
    const s = setup();
    await run(s, "U0ALICE", "queue leave a comment on #1 Well Done!");
    expect(s.agent.ask).toHaveBeenCalledWith(
      expect.objectContaining({ text: "queue leave a comment on #1 Well Done!", actor: "slack:U0ALICE", via: "slack" }),
    );
  });

  it("sends free text to the assistant and returns the answer privately", async () => {
    const s = setup();
    const replies = await run(s, "U0ALICE", "What should we review first?");
    expect(replies).toEqual(["You asked: What should we review first?\n\nReview #7 first."]);
    expect(s.agent.ask).toHaveBeenCalledWith(expect.objectContaining({ canPropose: true }));
  });

  it("an approver's /triage pending puts the cards with buttons in their DM, not the channel", async () => {
    const approvals = { listPending: vi.fn(() => [record()]), approve: vi.fn(), reject: vi.fn() };
    const s = setup({ approvals });
    const replies = await run(s, "U0BOSS", "pending");
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0]?.channel).toBe("U0BOSS");
    expect(JSON.stringify(s.posts[0]?.opts?.blocks)).toContain(APPROVE_ACTION);
    expect(replies.join()).toMatch(/Sent 1 approval card/);
  });

  it("a non-approver can see what is pending but gets no buttons", async () => {
    const approvals = { listPending: vi.fn(() => [record()]), approve: vi.fn(), reject: vi.fn() };
    const s = setup({ approvals });
    const replies = await run(s, "U0ALICE", "pending");
    expect(s.posts).toHaveLength(0);
    expect(replies.join()).toMatch(/only approvers can approve/);
  });
});

describe("direct messages and mentions", () => {
  it("answers in the same place, in the thread for a channel mention, and removes the 'working' note", async () => {
    const s = setup();
    await s.channel.handleMessage({ userId: "U0ALICE", channel: "C0TEAM", threadTs: "111.222", text: "<@U0BOT> why is #7 blocked?" });
    expect(s.agent.ask).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/^(?!.*<@U0BOT>).*why is #7 blocked\?$/), actor: "slack:U0ALICE" }),
    );
    expect(s.posts.every((p) => p.channel === "C0TEAM" && p.opts?.threadTs === "111.222")).toBe(true);
    expect(s.posts.map((p) => p.text)).toContain("Review #7 first.");
    expect(s.removed).toEqual([["C0TEAM", "ts1"]]); // the placeholder
  });

  describe("when every workspace member may chat (SLACK_ALLOW_ALL_MEMBERS)", () => {
    it("answers someone who is not on the list, in a DM and with /triage", async () => {
      const s = setup({ allowAll: true });
      await s.channel.handleMessage({ userId: "U0TESTER", channel: "D0X", text: "what should we review first?" });
      expect(s.agent.ask).toHaveBeenCalledTimes(1);
      expect(s.posts.map((p) => p.text).join("\n")).not.toMatch(/not on the access list/);

      const replies: string[] = [];
      await s.channel.handleCommand({ userId: "U0TESTER", text: "what is blocking #7?", reply: async (t) => void replies.push(t) });
      expect(s.agent.ask).toHaveBeenCalledTimes(2);
      expect(replies.join()).not.toMatch(/not on the access list/);
    });

    it("lets them ask for a comment but never makes them an approver", async () => {
      const s = setup({ allowAll: true });
      expect(s.channel.isApprover("slack:U0TESTER")).toBe(false);
      expect(s.channel.isApprover("slack:U0BOSS")).toBe(true);
      // The asker is passed on as an ordinary Slack actor; approving is decided by the approval service, not by chat access.
      await s.channel.handleMessage({ userId: "U0TESTER", channel: "D0X", text: "leave a comment on #7" });
      expect(s.agent.ask).toHaveBeenCalledWith(expect.objectContaining({ actor: "slack:U0TESTER" }));
    });

    it("is off by default: a stranger is still turned away", async () => {
      const s = setup({ allowAll: false });
      await s.channel.handleMessage({ userId: "U0TESTER", channel: "D0X", text: "hi" });
      expect(s.agent.ask).not.toHaveBeenCalled();
      expect(s.posts[0]?.text).toMatch(/not on the access list/);
    });
  });

  it("does not answer, or spend money for, someone who is not on the list", async () => {
    const s = setup();
    await s.channel.handleMessage({ userId: "U0STRANGER", channel: "D0X", text: "hi" });
    expect(s.agent.ask).not.toHaveBeenCalled();
    expect(s.posts[0]?.text).toMatch(/not on the access list/);
  });

  it("when the agent proposes a comment, every approver gets a card and the asker is told nothing is posted yet", async () => {
    const proposed = record();
    const s = setup({
      approvers: ["U0BOSS", "U0BOSS2"],
      ask: async () => ({ text: "I drafted a comment.", proposed: [proposed] }),
    });
    await s.channel.handleMessage({ userId: "U0ALICE", channel: "D0ALICE", text: "ask sam to fix CI on #7" });
    const cards = s.posts.filter((p) => p.opts?.blocks);
    expect(cards.map((c) => c.channel).sort()).toEqual(["U0BOSS", "U0BOSS2"]);
    expect(s.posts.map((p) => p.text).join("\n")).toMatch(/Nothing is posted until an approver approves it/);
  });

  it("says so, and keeps the request pending, if no approver can be reached", async () => {
    const s = setup({ ask: async () => ({ text: "Drafted.", proposed: [record()] }) });
    (s.api.post as ReturnType<typeof vi.fn>).mockImplementation(async (channel: string, text: string, opts?: { blocks?: unknown[] }) => {
      if (opts?.blocks) throw new Error("cannot_dm_bot");
      s.posts.push({ channel, text, opts });
      return "ts";
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await s.channel.handleMessage({ userId: "U0ALICE", channel: "D0ALICE", text: "ask sam to fix CI on #7" });
    expect(s.posts.map((p) => p.text).join("\n")).toMatch(/could not reach any approver on Slack/);
  });

  it("tells the person plainly if something breaks, and changes nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const s = setup({ ask: async () => { throw new Error("boom: secret detail"); } });
    await s.channel.handleMessage({ userId: "U0ALICE", channel: "D0ALICE", text: "anything" });
    const said = s.posts.map((p) => p.text).join("\n");
    expect(said).toMatch(/Nothing was changed/);
    expect(said).not.toMatch(/secret/);
  });

  it("handles one question at a time per person", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup({ ask: async () => { await gate; return { text: "done", proposed: [] }; } });
    const first = s.channel.handleMessage({ userId: "U0ALICE", channel: "D0ALICE", text: "one" });
    await new Promise((r) => setTimeout(r, 10));
    await s.channel.handleMessage({ userId: "U0ALICE", channel: "D0ALICE", text: "two" });
    expect(s.posts.map((p) => p.text).join("\n")).toMatch(/still working on your previous question/);
    release();
    await first;
    expect(s.agent.ask).toHaveBeenCalledTimes(1);
  });
});

describe("button clicks", () => {
  const click = async (
    s: ReturnType<typeof setup>,
    userId: string,
    kind: "approve" | "reject",
  ) => {
    const finished: string[] = [];
    const notices: string[] = [];
    await s.channel.handleDecision({
      userId,
      kind,
      id: record().id,
      finish: async (outcome) => void finished.push(outcome),
      notice: async (t) => void notices.push(t),
    });
    return { finished, notices };
  };

  it("lets a non-approver click, but nothing happens", async () => {
    const s = setup();
    const { finished, notices } = await click(s, "U0ALICE", "approve");
    expect(notices.join()).toMatch(/Only approvers/);
    expect(finished).toHaveLength(0);
    expect(s.approvals.approve).not.toHaveBeenCalled();
  });

  it("an approver's click is executed as that person, and the card shows the outcome", async () => {
    const approvals = {
      approve: vi.fn(async () => record({ status: "executed", resultUrl: "https://github.com/acme/app/pull/7#c1" })),
      reject: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const s = setup({ approvals });
    const { finished } = await click(s, "U0BOSS", "approve");
    expect(approvals.approve).toHaveBeenCalledWith(record().id, "slack:U0BOSS");
    expect(finished.join()).toMatch(/Posted the comment on #7/);
  });

  it("tells the person who asked, when someone else decided", async () => {
    const approvals = {
      approve: vi.fn(),
      reject: vi.fn(async () => record({ status: "rejected", requestedBy: "slack:U0ALICE" })),
      listPending: vi.fn(() => []),
    };
    const s = setup({ approvals });
    await click(s, "U0BOSS", "reject");
    const dm = s.posts.find((p) => p.channel === "U0ALICE");
    expect(dm?.text).toMatch(/Your request #11111111: Rejected/);
  });

  it("falls back to a private message if the card cannot be updated", async () => {
    const approvals = { approve: vi.fn(async () => record({ status: "executed" })), reject: vi.fn(), listPending: vi.fn(() => []) };
    const s = setup({ approvals });
    const notices: string[] = [];
    await s.channel.handleDecision({
      userId: "U0BOSS",
      kind: "approve",
      id: record().id,
      finish: async () => { throw new Error("message_not_found"); },
      notice: async (t) => void notices.push(t),
    });
    expect(notices.join()).toMatch(/Posted the comment/);
  });
});

describe("identity", () => {
  it("builds actor ids and checks approvers without trusting chat access", () => {
    const { channel } = setup({ allowed: ["U0ALICE"], approvers: ["U0BOSS"] });
    expect(slackActor("U0BOSS")).toBe("slack:U0BOSS");
    expect(channel.isApprover("slack:U0BOSS")).toBe(true);
    expect(channel.isApprover("slack:U0ALICE")).toBe(false);
    expect(channel.isApprover("telegram:U0BOSS")).toBe(false);
  });
});

describe("explainSlackError", () => {
  const platformError = (error: string, needed?: string) => Object.assign(new Error(`An API error occurred: ${error}`), { data: { error, needed } });

  it("says which token and which scope when the app-level token cannot open the connection", () => {
    const text = explainSlackError(platformError("missing_scope"), "SLACK_APP_TOKEN");
    expect(text).toMatch(/SLACK_APP_TOKEN/);
    expect(text).toMatch(/connections:write/);
  });

  it("names the missing permission for the bot token", () => {
    expect(explainSlackError(platformError("missing_scope", "im:write"), "SLACK_BOT_TOKEN")).toMatch(/im:write/);
  });

  it("explains a rejected token and passes unknown codes through", () => {
    expect(explainSlackError(platformError("invalid_auth"), "SLACK_BOT_TOKEN")).toMatch(/rejected by Slack/);
    expect(explainSlackError(platformError("ratelimited"), "SLACK_APP_TOKEN")).toBe("SLACK_APP_TOKEN: ratelimited");
    expect(explainSlackError(new Error("socket hang up"), "SLACK_APP_TOKEN")).toMatch(/socket hang up/);
  });
});