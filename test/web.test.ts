import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalService } from "../src/approvals/service.js";
import { BudgetService } from "../src/budget/service.js";
import { ActionRepository } from "../src/store/actions.js";
import { openDatabase } from "../src/store/db.js";
import { createWebApp } from "../src/web/server.js";
import { APP_JS } from "../src/web/ui.js";

const READER = "reader-key-0123456789";
const APPROVER = "approver-key-0123456789";
const APPROVER_ACTOR = "web:approver";

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function start(over: { accessKey?: string; approverKey?: string } = { accessKey: READER, approverKey: APPROVER }) {
  const db = openDatabase(":memory:");
  const github = {
    repo: "acme/app",
    listOpenPrs: vi.fn(async () => [] as never),
    getPr: vi.fn(),
    getPrSummary: vi.fn(async (n: number) => ({ number: n, title: "Fix login", sourceUrl: `https://github.com/acme/app/pull/${n}` })),
    postComment: vi.fn(async () => ({ id: 1, url: "https://github.com/acme/app/pull/7#c1" })),
    findCommentWithMarker: vi.fn(async () => null),
  };
  const approvals = new ApprovalService({
    github: github as never,
    repo: new ActionRepository(db),
    isApprover: (id) => id === APPROVER_ACTOR,
  });
  const budget = new BudgetService({
    db,
    monthlyBudgetUsd: 50,
    hostingUsd: 7,
    pricePerMInput: 0.15,
    pricePerMOutput: 0.6,
    dailyRequestsPerActor: 40,
  });
  const agent = { ask: vi.fn(async () => ({ text: "Review #7 first.", proposed: [] as never[] })) };
  const onProposed = vi.fn();
  const app = createWebApp({
    ...over,
    approverActor: APPROVER_ACTOR,
    agent: agent as never,
    approvals,
    github,
    budget,
    onProposed,
  });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, init: { key?: string; method?: string; body?: unknown; raw?: string } = {}) =>
    fetch(base + path, {
      method: init.method ?? (init.body !== undefined || init.raw !== undefined ? "POST" : "GET"),
      headers: {
        "Content-Type": "application/json",
        ...(init.key ? { Authorization: `Bearer ${init.key}` } : {}),
      },
      body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
    });
  return { call, github, approvals, agent, onProposed };
}

describe("public routes and headers", () => {
  it("serves the page and health check without a key, with security headers", async () => {
    const { call } = await start();
    expect((await call("/healthz")).status).toBe(200);
    const page = await call("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toMatch(/default-src 'self'/);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("x-powered-by")).toBeNull();
  });

  it("the page script never uses innerHTML (untrusted text is written as text only)", () => {
    expect(APP_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});

describe("authentication", () => {
  it("rejects missing and wrong keys, accepts either valid key", async () => {
    const { call } = await start();
    expect((await call("/api/queue")).status).toBe(401);
    expect((await call("/api/queue", { key: "nope-nope-nope-nope" })).status).toBe(401);
    expect((await call("/api/me", { key: READER })).status).toBe(200);
    expect(await (await call("/api/me", { key: APPROVER })).json()).toMatchObject({ role: "approver" });
  });

  it("locks out an address after repeated wrong keys", async () => {
    const { call } = await start();
    for (let i = 0; i < 10; i += 1) await call("/api/me", { key: "wrong-wrong-wrong-0" });
    expect((await call("/api/me", { key: READER })).status).toBe(429);
  });

  it("is disabled (503) when no keys are configured", async () => {
    const { call } = await start({});
    expect((await call("/api/me", { key: READER })).status).toBe(503);
  });

  it("refuses to start if both keys are the same", () => {
    expect(() =>
      createWebApp({ accessKey: READER, approverKey: READER, approverActor: "x", agent: {} as never, approvals: {} as never, github: {} as never, budget: {} as never }),
    ).toThrow(/must be different/);
  });
});

describe("chat", () => {
  it("passes the text to the agent as the reader identity and validates input", async () => {
    const { call, agent } = await start();
    const ok = await call("/api/chat", { key: READER, body: { text: "what first?", conversationId: "abcdefgh-1234" } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).text).toBe("Review #7 first.");
    expect(agent.ask).toHaveBeenCalledWith(expect.objectContaining({ actor: "web:reader", via: "web" }));

    expect((await call("/api/chat", { key: READER, body: { text: "", conversationId: "abcdefgh-1234" } })).status).toBe(400);
    expect((await call("/api/chat", { key: READER, body: { text: "hi", conversationId: "../x" } })).status).toBe(400);
    expect((await call("/api/chat", { key: READER, raw: "{not json" })).status).toBe(400);
  });
});

describe("approvals over the web", () => {
  async function withPending() {
    const ctx = await start();
    const rec = await ctx.approvals.propose({ prNumber: 7, body: "Please fix CI", reason: "CI red", requestedBy: "web:reader", via: "web" });
    return { ...ctx, id: rec.id };
  }

  it("a reader key can see the request but can NOT approve or reject it", async () => {
    const { call, github, id } = await withPending();
    const list = await (await call("/api/actions", { key: READER })).json();
    expect(list.actions[0].card).toContain("Exact comment text");
    expect((await call(`/api/actions/${id}/approve`, { key: READER, method: "POST", body: {} })).status).toBe(403);
    expect((await call(`/api/actions/${id}/reject`, { key: READER, method: "POST", body: {} })).status).toBe(403);
    expect(github.postComment).not.toHaveBeenCalled();
  });

  it("the approver key posts exactly once, even if clicked twice", async () => {
    const { call, github, id } = await withPending();
    const first = await call(`/api/actions/${id}/approve`, { key: APPROVER, method: "POST", body: {} });
    expect(first.status).toBe(200);
    expect((await first.json()).text).toMatch(/Posted the comment on #7/);
    const second = await call(`/api/actions/${id}/approve`, { key: APPROVER, method: "POST", body: {} });
    expect((await second.json()).text).toMatch(/already executed/);
    expect(github.postComment).toHaveBeenCalledTimes(1);
  });

  it("rejecting posts nothing", async () => {
    const { call, github, id } = await withPending();
    const r = await call(`/api/actions/${id}/reject`, { key: APPROVER, method: "POST", body: {} });
    expect((await r.json()).text).toMatch(/Nothing was posted/);
    expect(github.postComment).not.toHaveBeenCalled();
  });

  it("an unknown or malformed id is refused without touching GitHub", async () => {
    const { call, github } = await withPending();
    expect((await call("/api/actions/does-not-exist/approve", { key: APPROVER, method: "POST", body: {} })).status).toBe(409);
    expect((await call("/api/actions/a%20b/approve", { key: APPROVER, method: "POST", body: {} })).status).toBe(400);
    expect(github.postComment).not.toHaveBeenCalled();
  });
});
