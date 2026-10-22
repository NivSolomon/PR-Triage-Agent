import { describe, expect, it, vi } from "vitest";
import {
  APPROVE_ACTION,
  EDIT_ACTION,
  EDIT_VIEW,
  REJECT_ACTION,
  SlackChannel,
  approvalBlocks,
  decidedBlocks,
  editModal,
  explainSlackError,
  incomingDirectMessage,
  incomingEditedMention,
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
  originalBody: null,
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
  over: { githubUsers?: Record<string, string>; allowed?: string[]; approvers?: string[]; allowAll?: boolean; teamId?: string; teamChannelId?: string; ask?: () => Promise<unknown>; approvals?: object } = {},
) {
  const posts: Post[] = [];
  const removed: Array<[string, string]> = [];
  const homes: Array<{ userId: string; blocks: unknown[] }> = [];
  let n = 0;
  const api: SlackApi = {
    post: vi.fn(async (channel, text, opts) => {
      posts.push({ channel, text, opts });
      return { channel, ts: `ts${++n}` };
    }),
    remove: vi.fn(async (channel, ts) => void removed.push([channel, ts])),
    publishHome: vi.fn(async (userId, blocks) => void homes.push({ userId, blocks })),
    update: vi.fn(async () => undefined),
  };
  const agent = {
    ask: vi.fn(over.ask ?? (async () => ({ text: "Review #7 first.", proposed: [] as ActionRecord[], replaced: [] as ActionRecord[] }))),
  };
  const approvals = {
    approve: vi.fn(),
    reject: vi.fn(),
    listPending: vi.fn(() => []),
    rememberCard: vi.fn(),
    cardsFor: vi.fn((): { channel: string; ts: string }[] => []),
    ...(over.approvals ?? {}),
  };
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
    teamId: over.teamId,
    teamChannelId: over.teamChannelId,
    approverIds: over.approvers ?? ["U0BOSS"],
    githubUsers: over.githubUsers,
    agent: agent as never,
    approvals: approvals as never,
    github: github as never,
    budget: budget as never,
    api,
  });
  return { channel, api, posts, removed, homes, budget, agent, approvals: approvals as Record<string, ReturnType<typeof vi.fn>>, github };
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
    expect(actions.elements.map((e) => e.action_id)).toEqual([APPROVE_ACTION, EDIT_ACTION, REJECT_ACTION]);
    expect(actions.elements.every((e) => e.value === record().id)).toBe(true);
    expect(actions.elements[0]).toHaveProperty("confirm");
    expect(actions.elements[2]).toHaveProperty("confirm");
  });

  it("warns the approver when the comment would @-mention someone on GitHub", () => {
    const all = textOf(approvalBlocks(record({ body: "Please look @octocat" }))).join("\n");
    expect(all).toMatch(/@-mentions someone/);
  });

  it("shows the facts on separate lines and the exact comment in a code block", () => {
    const sections = textOf(approvalBlocks(record({ body: "Line one\nLine two" })));
    const all = sections.join("\n");
    expect(all).toContain("*Action:* post one public comment on pull request #7");
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

  it("passes the asker's linked GitHub login to the agent, and nothing when they are not linked", async () => {
    const s = setup({ allowed: ["U0ALICE", "U0BOB"], githubUsers: { U0ALICE: "alice-gh" } });
    await run(s, "U0ALICE", "what should I review?");
    await run(s, "U0BOB", "what should I review?");
    expect((s.agent.ask.mock.calls as unknown[][])[0]?.[0]).toMatchObject({ githubLogin: "alice-gh" });
    expect((s.agent.ask.mock.calls as unknown[][])[1]?.[0]).toMatchObject({ githubLogin: undefined });
  });

  it("explains how to get a personal queue only when the feature is set up and the user is not linked", async () => {
    const s = setup({ allowed: ["U0ALICE", "U0BOB"], githubUsers: { U0ALICE: "alice-gh" } });
    expect((await run(s, "U0BOB", "queue")).join()).toMatch(/SLACK_GITHUB_USERS/);
    expect((await run(s, "U0ALICE", "queue")).join()).not.toMatch(/SLACK_GITHUB_USERS/);
    expect((await run(setup(), "U0ALICE", "queue")).join()).not.toMatch(/SLACK_GITHUB_USERS/);
  });

  it("shows help for an empty command or 'help'", async () => {
    const s = setup();
    expect((await run(s, "U0ALICE", "")).join()).toMatch(/\/triage queue/);
    expect((await run(s, "U0ALICE", "help")).join()).toMatch(/\/triage queue/);
  });

  it("help spells out what the person may and may not do, and differs for an approver", async () => {
    const s = setup();
    const member = (await run(s, "U0ALICE", "help")).join("\n");
    expect(member).toMatch(/cannot approve/i);
    expect(member).toMatch(/never posts, merges, closes, approves or edits/i);
    expect(member).not.toMatch(/You are an APPROVER/);

    const boss = (await run(s, "U0BOSS", "help")).join("\n");
    expect(boss).toMatch(/You are an APPROVER/);
    expect(boss).toMatch(/approve or reject a comment request/i);
    // Help is plain text: Slack would show Markdown as raw symbols.
    expect(member).not.toMatch(/\*\*/);
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
    expect(s.agent.ask).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "slack:C0TEAM:111.222:U0ALICE" }),
    );
  });

  it("does not share a channel-thread conversation between two people", async () => {
    const s = setup({ allowed: ["U0ALICE", "U0BOB"] });
    await s.channel.handleMessage({ userId: "U0ALICE", channel: "C0TEAM", threadTs: "111.222", text: "<@U0BOT> one" });
    await s.channel.handleMessage({ userId: "U0BOB", channel: "C0TEAM", threadTs: "111.222", text: "<@U0BOT> two" });
    const ids = s.agent.ask.mock.calls.map((c) => (c as unknown as [{ conversationId: string }])[0].conversationId);
    expect(new Set(ids).size).toBe(2);
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

    it("lets them ask for a comment and approve it in Slack, recorded as themselves", async () => {
      const s = setup({ allowAll: true });
      expect(s.channel.isApprover("slack:U0TESTER")).toBe(true);
      expect(s.channel.isApprover("slack:U0BOSS")).toBe(true);
      expect(s.channel.isApprover("web:U0TESTER")).toBe(false);
      await s.channel.handleMessage({ userId: "U0TESTER", channel: "D0X", text: "leave a comment on #7" });
      expect(s.agent.ask).toHaveBeenCalledWith(expect.objectContaining({ actor: "slack:U0TESTER" }));

      const approvals = { approve: vi.fn(async () => record({ status: "executed" })), reject: vi.fn(), listPending: vi.fn(() => []) };
      const decided = setup({ allowAll: true, teamId: "T0HOME", approvals });
      const notices: string[] = [];
      await decided.channel.handleDecision({
        userId: "U0TESTER",
        teamId: "T0HOME",
        kind: "approve",
        id: record().id,
        finish: async () => undefined,
        notice: async (t) => void notices.push(t),
      });
      expect(approvals.approve).toHaveBeenCalledWith(record().id, "slack:U0TESTER");
      expect(notices).toHaveLength(0);
    });

    it("a Slack Connect click still cannot approve, even if they can see a card in a shared channel", async () => {
      const approvals = { approve: vi.fn(), reject: vi.fn(), listPending: vi.fn(() => []) };
      const s = setup({ allowAll: true, teamId: "T0HOME", approvals });
      const notices: string[] = [];
      await s.channel.handleDecision({
        userId: "U0OUTSIDER",
        teamId: "T0OTHER",
        kind: "approve",
        id: record().id,
        finish: async () => undefined,
        notice: async (t) => void notices.push(t),
      });
      expect(approvals.approve).not.toHaveBeenCalled();
      expect(notices.join()).toMatch(/Only approvers/);
    });

    it("help and the Home tab tell a workspace tester they can approve", async () => {
      const s = setup({ allowAll: true });
      const replies: string[] = [];
      await s.channel.handleCommand({ userId: "U0TESTER", text: "help", reply: async (t) => void replies.push(t) });
      expect(replies.join()).toMatch(/You are an APPROVER/);
      await s.channel.handleHomeOpened("U0TESTER");
      expect(JSON.stringify(s.homes[0]?.blocks)).toContain("You are an APPROVER");
    });

    it("posts the approval card to the named approvers, the asker, and the team channel", async () => {
      const proposed = record({ requestedBy: "slack:U0TESTER" });
      const s = setup({
        allowAll: true,
        teamChannelId: "C0TEAM",
        approvers: ["U0BOSS"],
        ask: async () => ({ text: "I drafted a comment.", proposed: [proposed], replaced: [] }),
      });
      await s.channel.handleMessage({ userId: "U0TESTER", channel: "D0X", text: "leave a comment on #7" });
      const cards = s.posts.filter((p) => p.opts?.blocks);
      expect(cards.map((c) => c.channel).sort()).toEqual(["C0TEAM", "U0BOSS", "U0TESTER"]);
      expect(s.approvals.rememberCard).toHaveBeenCalledTimes(3);
      expect(s.approvals.rememberCard).toHaveBeenCalledWith(proposed.id, "C0TEAM", expect.any(String));
      expect(s.approvals.rememberCard).toHaveBeenCalledWith(proposed.id, "U0BOSS", expect.any(String));
      expect(s.approvals.rememberCard).toHaveBeenCalledWith(proposed.id, "U0TESTER", expect.any(String));
    });

    it("refuses people Slack says belong to another workspace (Slack Connect), but not our own", async () => {
      const s = setup({ allowAll: true, teamId: "T0HOME" });
      await s.channel.handleMessage({ userId: "U0OUTSIDER", teamId: "T0OTHER", channel: "C0TEAM", text: "hi" });
      expect(s.agent.ask).not.toHaveBeenCalled();
      expect(s.posts[0]?.text).toMatch(/not on the access list/);

      const replies: string[] = [];
      await s.channel.handleCommand({ userId: "U0OUTSIDER", teamId: "T0OTHER", text: "what is blocking #7?", reply: async (t) => void replies.push(t) });
      expect(s.agent.ask).not.toHaveBeenCalled();
      expect(replies.join()).toMatch(/not on the access list/);

      await s.channel.handleMessage({ userId: "U0TESTER", teamId: "T0HOME", channel: "D0X", text: "hi" });
      expect(s.agent.ask).toHaveBeenCalledTimes(1);
    });

    it("still lets someone named on the list in, wherever they come from", async () => {
      const s = setup({ allowAll: true, teamId: "T0HOME", allowed: ["U0PARTNER"] });
      await s.channel.handleMessage({ userId: "U0PARTNER", teamId: "T0OTHER", channel: "C0TEAM", text: "hi" });
      expect(s.agent.ask).toHaveBeenCalledTimes(1);
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
      ask: async () => ({ text: "I drafted a comment.", proposed: [proposed], replaced: [] }),
    });
    await s.channel.handleMessage({ userId: "U0ALICE", channel: "D0ALICE", text: "ask sam to fix CI on #7" });
    const cards = s.posts.filter((p) => p.opts?.blocks);
    expect(cards.map((c) => c.channel).sort()).toEqual(["U0BOSS", "U0BOSS2"]);
    expect(s.posts.map((p) => p.text).join("\n")).toMatch(/Nothing is posted until an approver approves it/);
    expect(s.approvals.rememberCard).toHaveBeenCalled();
  });

  it("updates stored copies of a replaced card so Approve buttons disappear", async () => {
    const old = record({ id: "aaaaaaaa-1111-2222-3333-444444444444", status: "superseded" });
    const next = record({ id: "bbbbbbbb-1111-2222-3333-444444444444", body: "Well Done!" });
    const s = setup({
      approvals: {
        cardsFor: vi.fn((id: string) => (id === old.id ? [{ channel: "U0BOSS", ts: "ts-old" }] : [])),
        rememberCard: vi.fn(),
      },
    });
    await s.channel.sendApprovalCards(next, [old]);
    expect(s.api.update).toHaveBeenCalledWith(
      "U0BOSS",
      "ts-old",
      expect.stringMatching(/replaced by a newer request/i),
      expect.any(Array),
    );
    const blocks = (s.api.update as ReturnType<typeof vi.fn>).mock.calls[0]?.[3] as Array<{ type: string }>;
    expect(blocks.some((b) => b.type === "actions")).toBe(false);
    expect(s.approvals.rememberCard).toHaveBeenCalledWith(next.id, "U0BOSS", expect.stringMatching(/^ts/));
  });

  it("says so, and keeps the request pending, if no approver can be reached", async () => {
    const s = setup({ ask: async () => ({ text: "Drafted.", proposed: [record()], replaced: [] }) });
    (s.api.post as ReturnType<typeof vi.fn>).mockImplementation(async (channel: string, text: string, opts?: { blocks?: unknown[] }) => {
      if (opts?.blocks) throw new Error("cannot_dm_bot");
      s.posts.push({ channel, text, opts });
      return { channel, ts: "ts" };
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

  it("treats an edited DM as a new question (Slack does not re-send the original event)", async () => {
    const incoming = incomingDirectMessage({
      channel: "D0ALICE",
      channel_type: "im",
      subtype: "message_changed",
      message: { user: "U0ALICE", text: "leave a comment on #7 asking to fix CI" },
      previous_message: { text: "hello" },
    });
    expect(incoming).toEqual({ userId: "U0ALICE", channel: "D0ALICE", text: "leave a comment on #7 asking to fix CI" });
    const s = setup();
    await s.channel.handleMessage(incoming!);
    expect(s.agent.ask).toHaveBeenCalledWith(expect.objectContaining({ text: "leave a comment on #7 asking to fix CI" }));
  });

  it("ignores DM edits that did not change the text, bot edits, and channel messages", () => {
    expect(
      incomingDirectMessage({
        channel: "D0ALICE",
        channel_type: "im",
        subtype: "message_changed",
        message: { user: "U0ALICE", text: "same" },
        previous_message: { text: "same" },
      }),
    ).toBeNull();
    expect(
      incomingDirectMessage({
        channel: "D0ALICE",
        channel_type: "im",
        subtype: "message_changed",
        message: { user: "U0BOT", text: "updated card", bot_id: "B01" },
        previous_message: { text: "old card" },
      }),
    ).toBeNull();
    expect(
      incomingDirectMessage({
        channel: "C0TEAM",
        channel_type: "channel",
        subtype: "message_changed",
        message: { user: "U0ALICE", text: "<@U0BOT> now asking about #7" },
        previous_message: { text: "unrelated" },
      }),
    ).toBeNull();
  });

  it("treats an edited @mention in a channel as a new question", () => {
    const incoming = incomingEditedMention(
      {
        channel: "C0TEAM",
        channel_type: "channel",
        subtype: "message_changed",
        message: {
          user: "U0ALICE",
          text: "<@U0BOT> leave a comment on #7",
          ts: "111.222",
          thread_ts: "111.000",
        },
        previous_message: { text: "<@U0BOT> hello" },
      },
      "U0BOT",
    );
    expect(incoming).toEqual({
      userId: "U0ALICE",
      channel: "C0TEAM",
      threadTs: "111.000",
      text: "<@U0BOT> leave a comment on #7",
    });
  });

  it("ignores channel edits that do not mention the bot, and DMs (those have their own path)", () => {
    expect(
      incomingEditedMention(
        {
          channel: "C0TEAM",
          channel_type: "channel",
          subtype: "message_changed",
          message: { user: "U0ALICE", text: "no mention here" },
          previous_message: { text: "old" },
        },
        "U0BOT",
      ),
    ).toBeNull();
    expect(
      incomingEditedMention(
        {
          channel: "D0ALICE",
          channel_type: "im",
          subtype: "message_changed",
          message: { user: "U0ALICE", text: "<@U0BOT> hi" },
          previous_message: { text: "old" },
        },
        "U0BOT",
      ),
    ).toBeNull();
    expect(
      incomingEditedMention(
        {
          channel: "C0TEAM",
          channel_type: "channel",
          subtype: "message_changed",
          message: { user: "U0ALICE", text: "<@U0BOT> hi" },
          previous_message: { text: "old" },
        },
        undefined,
      ),
    ).toBeNull();
  });

  it("handles one question at a time per person", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup({ ask: async () => { await gate; return { text: "done", proposed: [], replaced: [] }; } });
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

  it("closes every stored copy of the card, not only the one that was clicked", async () => {
    const decided = record({ status: "executed", resultUrl: "https://github.com/acme/app/pull/7#c1" });
    const copies = [
      { channel: "D0BOSS", ts: "ts-dm" },
      { channel: "C0TEAM", ts: "ts-ch" },
    ];
    const s = setup({
      approvals: {
        approve: vi.fn(async () => decided),
        reject: vi.fn(),
        listPending: vi.fn(() => []),
        rememberCard: vi.fn(),
        cardsFor: vi.fn((id: string) => (id === decided.id ? copies : [])),
      },
    });
    await s.channel.handleDecision({
      userId: "U0BOSS",
      kind: "approve",
      id: decided.id,
      card: { channel: "C0TEAM", ts: "ts-ch" },
      finish: async () => undefined,
      notice: async () => undefined,
    });
    expect(s.approvals.rememberCard).toHaveBeenCalledWith(decided.id, "C0TEAM", "ts-ch");
    const updated = (s.api.update as ReturnType<typeof vi.fn>).mock.calls.map((c) => `${c[0]}/${c[1]}`).sort();
    expect(updated).toEqual(["C0TEAM/ts-ch", "D0BOSS/ts-dm"]);
    for (const call of (s.api.update as ReturnType<typeof vi.fn>).mock.calls) {
      const blocks = call[3] as Array<{ type: string }>;
      expect(blocks.some((b) => b.type === "actions")).toBe(false);
      expect(String(call[2])).toMatch(/Posted the comment on #7/);
    }
  });
});

describe("identity", () => {
  it("builds actor ids and checks approvers without trusting chat access", () => {
    const { channel } = setup({ allowed: ["U0ALICE"], approvers: ["U0BOSS"] });
    expect(slackActor("U0BOSS")).toBe("slack:U0BOSS");
    expect(channel.isApprover("slack:U0BOSS")).toBe(true);
    expect(channel.isApprover("slack:U0ALICE")).toBe(false);
    expect(channel.isApprover("web:U0BOSS")).toBe(false);
  });

  it("when every workspace member may approve, a web identity still cannot", () => {
    const { channel } = setup({ allowAll: true, approvers: ["U0BOSS"] });
    expect(channel.isApprover("slack:U0ALICE")).toBe(true);
    expect(channel.isApprover("web:U0BOSS")).toBe(false);
    expect(channel.isApprover("mcp:proposer:x")).toBe(false);
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

describe("Home tab", () => {
  const allText = (blocks: unknown[]): string =>
    JSON.stringify(blocks, (_k, v) => v).replace(/\\n/g, "\n");

  it("shows the guide to someone on the access list, with live numbers and no model call", async () => {
    const s = setup();
    await s.channel.handleHomeOpened("U0ALICE");
    expect(s.homes).toHaveLength(1);
    expect(s.homes[0]?.userId).toBe("U0ALICE");
    const text = allText(s.homes[0]?.blocks ?? []);
    expect(text).toContain("acme/app");
    expect(text).toContain("/triage queue");
    expect(text).toContain("AI budget mode: normal");
    expect(text).toContain("Requests waiting for approval: 0");
    expect(s.agent.ask).not.toHaveBeenCalled();
  });

  it("tells an approver they can approve, and a requester they cannot", async () => {
    const s = setup();
    await s.channel.handleHomeOpened("U0BOSS");
    await s.channel.handleHomeOpened("U0ALICE");
    expect(allText(s.homes[0]?.blocks ?? [])).toContain("You are an APPROVER");
    expect(allText(s.homes[1]?.blocks ?? [])).toContain("you cannot approve");
  });

  it("turns away a stranger on the Home tab too, giving them their member id", async () => {
    const s = setup();
    await s.channel.handleHomeOpened("U0STRANGER");
    const text = allText(s.homes[0]?.blocks ?? []);
    expect(text).toContain("not on the access list");
    expect(text).toContain("U0STRANGER");
    expect(text).not.toContain("/triage queue");
  });

  it("still shows the guide if the live numbers cannot be read", async () => {
    const s = setup();
    (s.budget.summary as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("db locked");
    });
    await s.channel.handleHomeOpened("U0ALICE");
    const text = allText(s.homes[0]?.blocks ?? []);
    expect(text).toContain("How to talk to me");
    expect(text).not.toContain("AI budget mode");
  });
});

describe("editing the comment before posting (Slack)", () => {
  const sectionText = (blocks: unknown[]): string =>
    (blocks as Array<{ type: string; text?: { text: string } }>).filter((b) => b.type === "section").map((b) => b.text?.text ?? "").join("\n");

  it("the card has an Edit button next to Approve and Reject, carrying only the request id", () => {
    const actions = approvalBlocks(record()).find((b) => b.type === "actions") as unknown as { elements: Array<Record<string, unknown>> };
    expect(actions.elements.map((e) => e.action_id)).toEqual([APPROVE_ACTION, EDIT_ACTION, REJECT_ACTION]);
    expect(actions.elements.every((e) => e.value === record().id)).toBe(true);
  });

  it("the pop-up is prefilled with the current text, limited in length, and says that submitting posts it", () => {
    const view = editModal(record({ body: "Please fix CI" }), { channel: "D1", ts: "1.2" });
    expect(view.callback_id).toBe(EDIT_VIEW);
    expect((view.submit as { text: string }).text).toBe("Post this comment");
    const input = (view.blocks.find((b) => b.type === "input") as unknown as { element: Record<string, unknown> }).element;
    expect(input).toMatchObject({ initial_value: "Please fix CI", max_length: 2000, multiline: true });
    expect(JSON.parse(view.private_metadata ?? "{}")).toEqual({ id: record().id, channel: "D1", ts: "1.2" });
  });

  it("an edited card shows the original draft, escaped, so the audit trail is visible on the card too", () => {
    const text = sectionText(approvalBlocks(record({ body: "New wording", originalBody: "Old <!channel> wording" })));
    expect(text).toContain("Edited by the approver");
    expect(text).toContain("Old &lt;!channel&gt; wording");
    expect(text).not.toContain("<!channel>");
    expect(sectionText(approvalBlocks(record()))).not.toContain("Edited by the approver");
  });

  const open = async (s: ReturnType<typeof setup>, userId: string) => {
    const opened: unknown[] = [];
    const notices: string[] = [];
    await s.channel.handleEditClick({
      userId,
      id: record().id,
      channel: "D1",
      ts: "1.2",
      open: async (v) => void opened.push(v),
      notice: async (t) => void notices.push(t),
    });
    return { opened, notices };
  };

  it("opens the pop-up for an approver on a pending request", async () => {
    const s = setup({ approvals: { approve: vi.fn(), reject: vi.fn(), listPending: vi.fn(() => []), get: vi.fn(() => record()) } });
    const { opened, notices } = await open(s, "U0BOSS");
    expect(opened).toHaveLength(1);
    expect(notices).toHaveLength(0);
  });

  it("does not open it for someone who cannot approve", async () => {
    const get = vi.fn(() => record());
    const s = setup({ approvals: { approve: vi.fn(), reject: vi.fn(), listPending: vi.fn(() => []), get } });
    const { opened, notices } = await open(s, "U0ALICE");
    expect(opened).toHaveLength(0);
    expect(notices.join()).toMatch(/Only approvers/);
    expect(get).not.toHaveBeenCalled();
  });

  it("does not open it for a request that is already decided or gone, and says why", async () => {
    const decided = setup({ approvals: { approve: vi.fn(), reject: vi.fn(), listPending: vi.fn(() => []), get: vi.fn(() => record({ status: "rejected" })) } });
    const a = await open(decided, "U0BOSS");
    expect(a.opened).toHaveLength(0);
    expect(a.notices.join()).toMatch(/Rejected/);
    const gone = setup({ approvals: { approve: vi.fn(), reject: vi.fn(), listPending: vi.fn(() => []), get: vi.fn(() => null) } });
    const b = await open(gone, "U0BOSS");
    expect(b.opened).toHaveLength(0);
    expect(b.notices.join()).toMatch(/cannot find that request/);
  });

  const submit = async (s: ReturnType<typeof setup>, userId: string, editedBody: string) => {
    const finished: Array<[string, ActionRecord | undefined]> = [];
    const notices: string[] = [];
    await s.channel.handleDecision({
      userId,
      kind: "approve",
      id: record().id,
      editedBody,
      finish: async (outcome, rec) => void finished.push([outcome, rec]),
      notice: async (t) => void notices.push(t),
    });
    return { finished, notices };
  };

  it("submitting the pop-up approves as that person with their text, and the outcome says it was edited", async () => {
    const edited = record({ status: "executed", body: "New wording", originalBody: "Please fix CI", resultUrl: "https://github.com/acme/app/pull/7#c1" });
    const approvals = { approve: vi.fn(async () => edited), reject: vi.fn(), listPending: vi.fn(() => []) };
    const s = setup({ approvals });
    const { finished } = await submit(s, "U0BOSS", "New wording");
    expect(approvals.approve).toHaveBeenCalledWith(record().id, "slack:U0BOSS", { editedBody: "New wording" });
    expect(finished[0]?.[0]).toMatch(/Posted your edited comment on #7/);
    expect(finished[0]?.[1]).toMatchObject({ body: "New wording", originalBody: "Please fix CI" });
  });

  it("a non-approver who somehow submits changes nothing", async () => {
    const approvals = { approve: vi.fn(), reject: vi.fn(), listPending: vi.fn(() => []) };
    const s = setup({ approvals });
    const { finished, notices } = await submit(s, "U0ALICE", "Sneaky");
    expect(approvals.approve).not.toHaveBeenCalled();
    expect(finished).toHaveLength(0);
    expect(notices.join()).toMatch(/Only approvers/);
  });

  it("if someone else decided first, the editor is told privately and the card is left alone", async () => {
    const { ApprovalError } = await import("../src/approvals/service.js");
    const approvals = {
      approve: vi.fn(async () => {
        throw new ApprovalError("not_pending", "This action is already executed; it was not run again.");
      }),
      reject: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const s = setup({ approvals });
    const { finished } = await submit(s, "U0BOSS", "Late edit");
    // No record comes back, which is what makes the pop-up handler send a private message instead of editing the card.
    expect(finished[0]?.[0]).toMatch(/already executed/);
    expect(finished[0]?.[1]).toBeUndefined();
  });
});