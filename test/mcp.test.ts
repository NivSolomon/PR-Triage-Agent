import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpRouter } from "../src/mcp/server.js";

const READER = "reader-token-0123456789";
const PROPOSER = "proposer-token-0123456789";

let server: Server | undefined;
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function start() {
  const github = {
    repo: "acme/app",
    listOpenPrs: vi.fn(async () => [] as never),
    getPr: vi.fn(),
  };
  const approvals = {
    propose: vi.fn(async (i: { prNumber: number; body: string }) => ({
      id: "act-1",
      status: "pending",
      prNumber: i.prNumber,
      body: i.body,
    })),
  };
  const agent = { ask: vi.fn(async () => ({ text: "answer", proposed: [] as never[] })) };
  const onProposed = vi.fn();
  const app = express();
  app.use(express.json());
  app.use(
    "/mcp",
    createMcpRouter({
      tokens: { [READER]: "reader", [PROPOSER]: "proposer" },
      agent: agent as never,
      tools: { github, approvals: approvals as never },
      onProposed,
    }),
  );
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  const connect = async (token: string) => {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    clients.push(client);
    return client;
  };
  return { url, connect, github, approvals, agent, onProposed };
}

const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0] as { text: string }).text;

describe("MCP authentication", () => {
  it("rejects calls without a valid token", async () => {
    const { url } = await start();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    expect((await fetch(url, { method: "POST", headers, body })).status).toBe(401);
    expect((await fetch(url, { method: "POST", headers: { ...headers, Authorization: "Bearer wrong-wrong-wrong-1" }, body })).status).toBe(401);
    expect((await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${READER}` } })).status).toBe(405);
  });
});

describe("MCP permissions", () => {
  it("a reader sees only read tools; the write tool is not even listed", async () => {
    const { connect } = await start();
    const names = (await (await connect(READER)).listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["ask_triage_agent", "get_pull_request", "get_review_queue"]);
  });

  it("a reader cannot call propose_comment: nothing is created", async () => {
    const { connect, approvals, onProposed } = await start();
    const client = await connect(READER);
    const res = await client
      .callTool({ name: "propose_comment", arguments: { prNumber: 1, body: "hi", reason: "r" } })
      .catch((e: Error) => e);
    const failed = res instanceof Error || (res as { isError?: boolean }).isError === true;
    expect(failed).toBe(true);
    expect(approvals.propose).not.toHaveBeenCalled();
    expect(onProposed).not.toHaveBeenCalled();
  });

  it("no role has any tool that approves, rejects or posts", async () => {
    const { connect } = await start();
    const names = (await (await connect(PROPOSER)).listTools()).tools.map((t) => t.name);
    expect(names).toContain("propose_comment");
    expect(names.some((n) => /approve|reject|post|execute|merge/i.test(n.replace("propose_comment", "")))).toBe(false);
  });

  it("a proposer creates a PENDING request attributed to its own id; nothing is posted", async () => {
    const { connect, approvals, onProposed } = await start();
    const client = await connect(PROPOSER);
    const res = await client.callTool({
      name: "propose_comment",
      arguments: { prNumber: 7, body: "Please fix CI", reason: "CI is red" },
    });
    const out = JSON.parse(textOf(res));
    expect(out.status).toBe("pending_approval");
    expect(out.note).toMatch(/NOT posted/);
    expect(approvals.propose).toHaveBeenCalledWith(
      expect.objectContaining({ prNumber: 7, via: "mcp", requestedBy: expect.stringMatching(/^mcp:proposer:[0-9a-f]{8}$/) }),
    );
    expect(onProposed).toHaveBeenCalledTimes(1);
  });

  it("the ask tool inherits the caller's role: readers cannot let the agent propose", async () => {
    const { connect, agent } = await start();
    await (await connect(READER)).callTool({ name: "ask_triage_agent", arguments: { question: "leave a comment on #7" } });
    await (await connect(PROPOSER)).callTool({ name: "ask_triage_agent", arguments: { question: "leave a comment on #7" } });
    const calls = agent.ask.mock.calls as unknown as [{ canPropose: boolean; via: string }][];
    expect(calls[0]?.[0]).toMatchObject({ canPropose: false, via: "mcp" });
    expect(calls[1]?.[0]).toMatchObject({ canPropose: true, via: "mcp" });
  });

  it("read tools return live data through MCP", async () => {
    const { connect, github } = await start();
    const res = await (await connect(READER)).callTool({ name: "get_review_queue", arguments: {} });
    expect(github.listOpenPrs).toHaveBeenCalled();
    expect(JSON.parse(textOf(res)).repo).toBe("acme/app");
  });
});
