/**
 * One wired copy of the app, with fakes only at the edges (GitHub, Slack API, the model).
 * End-to-end tests drive Slack, the web page and MCP through the same ApprovalService,
 * so a comment is posted to GitHub only after a human decision, and only once.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { vi } from "vitest";
import { Agent } from "../../src/agent/agent.js";
import type { LlmPort, LlmRequest, LlmResponse } from "../../src/agent/llm.js";
import { makeIsApprover } from "../../src/app.js";
import { ApprovalService } from "../../src/approvals/service.js";
import { BudgetService } from "../../src/budget/service.js";
import type { SlackApi } from "../../src/channels/slack.js";
import { SlackChannel } from "../../src/channels/slack.js";
import { loadConfig } from "../../src/config.js";
import { createMcpRouter } from "../../src/mcp/server.js";
import { runDigest } from "../../src/scheduler/digest.js";
import { ActionRepository } from "../../src/store/actions.js";
import { openDatabase } from "../../src/store/db.js";
import { RunRepository } from "../../src/store/runs.js";
import { createWebApp } from "../../src/web/server.js";
import { makeFixtureGitHub } from "../../evals/fixtures.js";

export const BOSS = "U0BOSS";
export const TESTER = "U0TESTER";
export const TEAM = "C0TEAM";
export const DANA_KEY = "dana-e2e-key-01234567";
export const LEE_KEY = "lee-e2e-key-0123456789";
export const MCP_READER = "mcp-reader-token-012";
export const MCP_PROPOSER = "mcp-proposer-token-01";
export const COMMENT = "Please fix the failing unit-tests before review.";
export const CSRF = { "X-Requested-With": "pr-triage" };

export interface SlackPost {
  channel: string;
  text: string;
  ts: string;
  opts?: { threadTs?: string; blocks?: unknown[] };
}

export interface SlackUpdate {
  channel: string;
  ts: string;
  text: string;
  blocks: unknown[];
}

function lastAssistantTool(req: LlmRequest): string | undefined {
  for (let i = req.messages.length - 1; i >= 0; i -= 1) {
    const m = req.messages[i];
    if (m && m.role === "assistant" && m.toolCalls?.[0]) return m.toolCalls[0].name;
  }
  return undefined;
}

/** A model that fetches one PR, then proposes a comment, then answers. No network. */
export function commentLlm(pr = 102, bodies: string | string[] = COMMENT): LlmPort {
  const drafts = Array.isArray(bodies) ? bodies : [bodies];
  let proposed = 0;
  return {
    model: "e2e-fake",
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const names = req.tools.map((t) => t.name);
      const last = req.messages.at(-1);
      if (last?.role === "tool" && lastAssistantTool(req) === "get_pull_request" && names.includes("propose_comment")) {
        const body = drafts[Math.min(proposed, drafts.length - 1)] ?? COMMENT;
        proposed += 1;
        return call("propose_comment", { prNumber: pr, body, reason: "CI is failing on this PR." });
      }
      if (last?.role === "user" && names.includes("get_pull_request")) {
        return call("get_pull_request", { number: pr });
      }
      return {
        content: `I drafted a comment on #${pr}. Nothing is posted until an approver approves it.`,
        toolCalls: [],
        usage: { inputTokens: 20, outputTokens: 30 },
      };
    },
  };
}

/** A model that loads the queue and names #101 as what to review first. */
export function queueLlm(): LlmPort {
  return {
    model: "e2e-fake",
    async complete(req: LlmRequest): Promise<LlmResponse> {
      const last = req.messages.at(-1);
      if (last?.role === "user" && req.tools.some((t) => t.name === "get_review_queue")) {
        return call("get_review_queue", {});
      }
      return {
        content:
          "Review #101 Fix login redirect loop first: https://github.com/acme/app/pull/101. It is small, green and unreviewed.",
        toolCalls: [],
        usage: { inputTokens: 20, outputTokens: 40 },
      };
    },
  };
}

function call(name: string, args: unknown): LlmResponse {
  return {
    content: null,
    toolCalls: [{ id: `call-${name}`, name, arguments: JSON.stringify(args) }],
    usage: { inputTokens: 10, outputTokens: 8 },
  };
}

export interface E2eApp {
  github: ReturnType<typeof makeFixtureGitHub>;
  approvals: ApprovalService;
  slack: SlackChannel;
  posts: SlackPost[];
  updates: SlackUpdate[];
  base: string;
  runs: RunRepository;
  db: DatabaseSync;
  login(key: string): Promise<{ cookie: string; status: number }>;
  api(
    path: string,
    init?: { cookie?: string; method?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<Response>;
  mcp(token: string): Promise<Client>;
  digest(): Promise<{ ok: boolean }>;
  stop(): Promise<void>;
}

/**
 * The same composition as `createApp`, without Socket Mode or a real model.
 * Slack, web and MCP share one database and one ApprovalService.
 */
export async function startE2e(over: { llm?: LlmPort } = {}): Promise<E2eApp> {
  const db = openDatabase(":memory:");
  const github = makeFixtureGitHub();
  const config = loadConfig({
    SLACK_APPROVER_USER_IDS: BOSS,
    SLACK_ALLOW_ALL_MEMBERS: "true",
    SLACK_DIGEST_CHANNEL_ID: TEAM,
    WEB_USERS: JSON.stringify({
      dana: { key: DANA_KEY, role: "approver", github: "dana" },
      lee: { key: LEE_KEY, role: "reader" },
    }),
    MCP_TOKENS: JSON.stringify({ [MCP_READER]: "reader", [MCP_PROPOSER]: "proposer" }),
    AUTH_MAX_FAILURES: "0",
    DATABASE_PATH: ":memory:",
  });

  const budget = new BudgetService({
    db,
    monthlyBudgetUsd: config.MONTHLY_BUDGET_USD,
    hostingUsd: config.HOSTING_COST_USD,
    pricePerMInput: config.LLM_PRICE_INPUT_PER_M,
    pricePerMOutput: config.LLM_PRICE_OUTPUT_PER_M,
    dailyRequestsPerActor: config.DAILY_REQUESTS_PER_USER,
  });

  const posts: SlackPost[] = [];
  const updates: SlackUpdate[] = [];
  let n = 0;
  const api: SlackApi = {
    post: vi.fn(async (channel, text, opts) => {
      const ts = `ts${++n}`;
      posts.push({ channel, text, ts, opts });
      return { channel, ts };
    }),
    remove: vi.fn(async () => undefined),
    publishHome: vi.fn(async () => undefined),
    update: vi.fn(async (channel, ts, text, blocks) => {
      updates.push({ channel, ts, text, blocks });
    }),
  };

  const slackRef: { current?: SlackChannel } = {};
  const approvals = new ApprovalService({
    github: github as never,
    repo: new ActionRepository(db),
    isApprover: makeIsApprover(config),
    onRetired: (records) => slackRef.current?.retireCards(records) ?? Promise.resolve(),
  });

  const agent = new Agent({
    llm: over.llm ?? commentLlm(),
    tools: { github: github as never, approvals },
    budget,
  });

  const slack = new SlackChannel({
    botToken: "xoxb-e2e",
    appToken: "xapp-e2e",
    allowedIds: [],
    allowAllMembers: true,
    approverIds: [BOSS],
    teamChannelId: TEAM,
    teamId: "T0HOME",
    githubUsers: { [BOSS]: "dana" },
    agent,
    approvals,
    github: github as never,
    budget,
    api,
  });
  slackRef.current = slack;

  const runs = new RunRepository(db);
  const mcpClients: Client[] = [];
  const web = createWebApp({
    users: config.WEB_USERS,
    sessionDb: db,
    maxFailures: 0,
    approverActor: "web:approver",
    agent,
    approvals,
    github: github as never,
    budget,
    digest: {
      cron: config.DIGEST_CRON,
      timezone: "UTC",
      target: "the team's Slack digest channel",
      nextRun: () => null,
      runs,
    },
    onProposed: async (record, replaced) => void (await slack.sendApprovalCards(record, replaced)),
    onDecided: async (result) => {
      const requester = result.record?.requestedBy;
      if (requester?.startsWith("slack:")) {
        await slack.send(requester.replace("slack:", ""), `Your request #${result.record?.id.slice(0, 8)}: ${result.text}`);
      }
    },
    mount: (expressApp) =>
      expressApp.use(
        "/mcp",
        createMcpRouter({
          tokens: config.MCP_TOKENS,
          maxFailures: 0,
          agent,
          tools: { github: github as never, approvals },
          onProposed: async (record, replaced) => void (await slack.sendApprovalCards(record, replaced)),
        }),
      ),
  });

  const server: Server = await new Promise((resolve) => {
    const s = web.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = (
    path: string,
    init: { cookie?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) =>
    fetch(base + path, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers: {
        "Content-Type": "application/json",
        ...(init.cookie ? { Cookie: init.cookie, ...CSRF } : {}),
        ...init.headers,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  return {
    github,
    approvals,
    slack,
    posts,
    updates,
    base,
    runs,
    db,
    async login(key: string) {
      const res = await call("/api/login", { body: { key } });
      const set = res.headers.get("set-cookie") ?? "";
      return { cookie: set.split(";")[0] ?? "", status: res.status };
    },
    api: call,
    async mcp(token: string) {
      const client = new Client({ name: "e2e", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      mcpClients.push(client);
      return client;
    },
    digest: () =>
      runDigest({
        github: github as never,
        send: (text) => slack.send(TEAM, text),
        runs,
      }),
    async stop() {
      await Promise.all(mcpClients.splice(0).map((c) => c.close().catch(() => undefined)));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

export const cardPosts = (h: E2eApp): SlackPost[] => h.posts.filter((p) => p.opts?.blocks);

export const hasButtons = (blocks: unknown): boolean =>
  Array.isArray(blocks) && blocks.some((b) => (b as { type?: string }).type === "actions");

const mcpText = (r: unknown): string => ((r as { content: { text: string }[] }).content[0] as { text: string }).text;

export const mcpJson = (r: unknown): Record<string, unknown> => JSON.parse(mcpText(r)) as Record<string, unknown>;
