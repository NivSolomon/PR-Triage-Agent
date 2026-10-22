import { afterEach, describe, expect, it } from "vitest";
import { actionMarker } from "../src/approvals/service.js";
import { prUrl } from "../evals/fixtures.js";
import {
  BOSS,
  COMMENT,
  DANA_KEY,
  LEE_KEY,
  MCP_PROPOSER,
  MCP_READER,
  TEAM,
  TESTER,
  cardPosts,
  commentLlm,
  hasButtons,
  mcpJson,
  queueLlm,
  startE2e,
  type E2eApp,
} from "./e2e/harness.js";

const ASK_COMMENT = "Leave a comment on #102 asking sam to fix the failing unit-tests.";

let app: E2eApp | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

const postedBodies = (h: E2eApp) => h.github.calls.postComment.map((p) => p.body);

describe("end to end: Slack ask → approve → GitHub post", () => {
  it("posts the approved text once, and closes the card in the app DM and the team channel", async () => {
    app = await startE2e();
    await app.slack.handleMessage({ userId: TESTER, teamId: "T0HOME", channel: "D0TESTER", text: ASK_COMMENT });

    const pending = app.approvals.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ prNumber: 102, body: COMMENT, status: "pending", requestedVia: "slack" });
    expect(postedBodies(app)).toEqual([]);

    const cards = cardPosts(app);
    expect(cards.map((c) => c.channel).sort()).toEqual([BOSS, TEAM, TESTER].sort());
    expect(cards.every((c) => hasButtons(c.opts?.blocks))).toBe(true);

    const id = pending[0]!.id;
    const channelCard = cards.find((c) => c.channel === TEAM)!;
    await app.slack.handleDecision({
      userId: TESTER,
      teamId: "T0HOME",
      kind: "approve",
      id,
      card: { channel: channelCard.channel, ts: channelCard.ts },
      finish: async () => undefined,
      notice: async () => undefined,
    });

    expect(postedBodies(app)).toHaveLength(1);
    expect(postedBodies(app)[0]).toContain(COMMENT);
    expect(postedBodies(app)[0]).toContain(actionMarker(id));
    expect(app.approvals.get(id)?.status).toBe("executed");
    expect(app.approvals.get(id)?.resultUrl).toBe(`${prUrl(102)}#issuecomment-1`);

    expect([...new Set(app.updates.map((u) => u.channel))].sort()).toEqual([BOSS, TEAM, TESTER].sort());
    expect(app.updates.every((u) => !hasButtons(u.blocks))).toBe(true);
    expect(app.updates.every((u) => /Posted the comment on #102/.test(u.text))).toBe(true);

    await app.slack.handleDecision({
      userId: BOSS,
      kind: "approve",
      id,
      finish: async () => undefined,
      notice: async () => undefined,
    });
    expect(postedBodies(app)).toHaveLength(1);
  });

  it("a reject posts nothing and takes the buttons off every copy", async () => {
    app = await startE2e();
    await app.slack.handleMessage({ userId: BOSS, teamId: "T0HOME", channel: "D0BOSS", text: ASK_COMMENT });
    const id = app.approvals.listPending()[0]!.id;
    await app.slack.handleDecision({
      userId: BOSS,
      kind: "reject",
      id,
      finish: async () => undefined,
      notice: async () => undefined,
    });
    expect(postedBodies(app)).toEqual([]);
    expect(app.approvals.get(id)?.status).toBe("rejected");
    expect(app.updates.length).toBeGreaterThan(0);
    expect(app.updates.every((u) => !hasButtons(u.blocks))).toBe(true);
    expect(app.updates[0]?.text).toMatch(/Rejected/);
  });

  it("an edited approval posts the new wording and keeps the original draft", async () => {
    app = await startE2e();
    await app.slack.handleMessage({ userId: BOSS, teamId: "T0HOME", channel: "D0BOSS", text: ASK_COMMENT });
    const id = app.approvals.listPending()[0]!.id;
    await app.slack.handleDecision({
      userId: BOSS,
      kind: "approve",
      id,
      editedBody: "LALALALA!",
      finish: async () => undefined,
      notice: async () => undefined,
    });
    expect(postedBodies(app)[0]).toContain("LALALALA!");
    expect(postedBodies(app)[0]).not.toContain(COMMENT);
    const done = app.approvals.get(id)!;
    expect(done.body).toBe("LALALALA!");
    expect(done.originalBody).toBe(COMMENT);
    expect(app.updates.some((u) => /Posted your edited comment on #102/.test(u.text))).toBe(true);
  });
});

describe("end to end: web reader asks, web approver decides", () => {
  it("the reader can request a comment; only the approver can post it; Slack cards close too", async () => {
    app = await startE2e();
    const lee = await app.login(LEE_KEY);
    expect(lee.status).toBe(200);
    const chat = await app.api("/api/chat", {
      cookie: lee.cookie,
      body: { text: ASK_COMMENT, conversationId: "e2e-web-01" },
    });
    expect(chat.status).toBe(200);
    const asked = (await chat.json()) as { proposed: { id: string }[] };
    expect(asked.proposed).toHaveLength(1);
    const id = asked.proposed[0]!.id;
    expect(cardPosts(app).map((c) => c.channel).sort()).toEqual([BOSS, TEAM].sort());
    expect(postedBodies(app)).toEqual([]);

    const forbidden = await app.api(`/api/actions/${id}/approve`, { cookie: lee.cookie, body: {} });
    expect(forbidden.status).toBe(403);
    expect(postedBodies(app)).toEqual([]);

    const dana = await app.login(DANA_KEY);
    const approved = await app.api(`/api/actions/${id}/approve`, { cookie: dana.cookie, body: {} });
    expect(approved.status).toBe(200);
    expect(postedBodies(app)).toHaveLength(1);
    expect(postedBodies(app)[0]).toContain(COMMENT);
    expect(app.approvals.get(id)?.decidedBy).toBe("web:dana");
    expect(app.updates.every((u) => !hasButtons(u.blocks))).toBe(true);
  });

  it("the ranked queue needs no model and does not write to GitHub", async () => {
    app = await startE2e({ llm: queueLlm() });
    const dana = await app.login(DANA_KEY);
    const res = await app.api("/api/queue", { cookie: dana.cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { queue: { items: { number: number; state: string }[] }; text: string };
    expect(body.queue.items[0]?.number).toBe(101);
    expect(body.text).toMatch(/#101/);
    expect(postedBodies(app)).toEqual([]);
  });

  it("asking what to review first answers from the live queue and names #101", async () => {
    app = await startE2e({ llm: queueLlm() });
    const dana = await app.login(DANA_KEY);
    const res = await app.api("/api/chat", {
      cookie: dana.cookie,
      body: { text: "What should we review first?", conversationId: "e2e-web-02" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; proposed: unknown[] };
    expect(body.proposed).toEqual([]);
    expect(body.text).toMatch(/#101/);
    expect(body.text).toMatch(/github.com\/acme\/app\/pull\/101/);
    expect(postedBodies(app)).toEqual([]);
  });
});

describe("end to end: MCP proposes, a human approves", () => {
  it("a proposer token creates a pending request; Slack approves it; MCP itself cannot approve", async () => {
    app = await startE2e();
    const client = await app.mcp(MCP_PROPOSER);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("propose_comment");
    expect(names.some((n) => n !== "propose_comment" && /approve|reject|post|execute|merge/i.test(n))).toBe(false);

    const created = await client.callTool({
      name: "propose_comment",
      arguments: { prNumber: 102, body: COMMENT, reason: "CI is red" },
    });
    const out = mcpJson(created);
    expect(out.status).toBe("pending_approval");
    expect(String(out.note)).toMatch(/NOT posted/i);
    expect(postedBodies(app)).toEqual([]);

    const pending = app.approvals.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.requestedVia).toBe("mcp");
    expect(pending[0]?.requestedBy).toMatch(/^mcp:proposer:[0-9a-f]{8}$/);
    expect(cardPosts(app).length).toBeGreaterThan(0);

    await app.slack.handleDecision({
      userId: BOSS,
      kind: "approve",
      id: pending[0]!.id,
      finish: async () => undefined,
      notice: async () => undefined,
    });
    expect(postedBodies(app)).toHaveLength(1);
    expect(postedBodies(app)[0]).toContain(COMMENT);
  });

  it("a reader token cannot propose, even by asking the agent nicely", async () => {
    app = await startE2e();
    const reader = await app.mcp(MCP_READER);
    const names = (await reader.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("propose_comment");

    const failed = await reader
      .callTool({ name: "propose_comment", arguments: { prNumber: 102, body: COMMENT, reason: "x" } })
      .catch((e: Error) => e);
    expect(failed instanceof Error || (failed as { isError?: boolean }).isError === true).toBe(true);
    expect(app.approvals.listPending()).toEqual([]);
    expect(postedBodies(app)).toEqual([]);
  });
});

describe("end to end: replacing a draft, the digest, and /triage queue", () => {
  it("asking again on the same PR withdraws the old card; only the new text can be posted", async () => {
    const next = "Please add a test for the CSV export.";
    app = await startE2e({ llm: commentLlm(102, [COMMENT, next]) });
    await app.slack.handleMessage({ userId: BOSS, teamId: "T0HOME", channel: "D0BOSS", text: ASK_COMMENT });
    const first = app.approvals.listPending()[0]!;
    expect(first.body).toBe(COMMENT);

    await app.slack.handleMessage({
      userId: BOSS,
      teamId: "T0HOME",
      channel: "D0BOSS",
      text: 'Leave a comment on #102 asking "Please add a test for the CSV export."',
    });
    const open = app.approvals.listPending();
    expect(open).toHaveLength(1);
    expect(open[0]?.body).toBe(next);
    expect(app.approvals.get(first.id)?.status).toBe("superseded");
    expect(app.updates.some((u) => u.text.toLowerCase().includes("replaced"))).toBe(true);

    await app.slack.handleDecision({
      userId: BOSS,
      kind: "approve",
      id: first.id,
      finish: async () => undefined,
      notice: async () => undefined,
    });
    expect(postedBodies(app)).toEqual([]);

    await app.slack.handleDecision({
      userId: BOSS,
      kind: "approve",
      id: open[0]!.id,
      finish: async () => undefined,
      notice: async () => undefined,
    });
    expect(postedBodies(app)).toHaveLength(1);
    expect(postedBodies(app)[0]).toContain(next);
    expect(postedBodies(app)[0]).not.toContain(COMMENT);
  });

  it("/triage queue ranks from GitHub with no model call and no write", async () => {
    app = await startE2e({ llm: queueLlm() });
    const replies: string[] = [];
    await app.slack.handleCommand({
      userId: BOSS,
      teamId: "T0HOME",
      text: "queue",
      reply: async (t) => void replies.push(t),
    });
    expect(replies.join()).toMatch(/#101/);
    expect(replies.join()).toMatch(/needs review/);
    expect(postedBodies(app)).toEqual([]);
  });

  it("the morning digest is built from the queue, delivered to the team channel, and recorded", async () => {
    app = await startE2e();
    const result = await app.digest();
    expect(result.ok).toBe(true);
    const sent = app.posts.filter((p) => p.channel === TEAM && !p.opts?.blocks);
    expect(sent.some((p) => p.text.startsWith("PR digest for acme/app"))).toBe(true);
    expect(sent.some((p) => p.text.includes("#101"))).toBe(true);
    const last = app.runs.recent("digest")[0];
    expect(last?.ok).toBe(true);
    expect(last?.text).toMatch(/#101/);
    expect(postedBodies(app)).toEqual([]);
  });
});
