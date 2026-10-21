import { createHash } from "node:crypto";
import express from "express";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Agent } from "../agent/agent.js";
import { runTool } from "../agent/tools.js";
import type { ToolContext, ToolDeps } from "../agent/tools.js";
import type { ActionRecord } from "../store/actions.js";
import { FailureThrottle, bearerToken, sameSecret } from "../web/throttle.js";

/**
 * What an MCP client may do, by token:
 *
 *   reader    read the queue and PRs, ask the agent questions
 *   proposer  everything a reader can, plus CREATE a comment request
 *
 * No role can approve or post. A proposal only creates a pending request that a human
 * approver must approve in Slack or on the web page. The tool for proposing is not even
 * listed for readers, and the executor re-checks the permission (see agent/tools.ts).
 */
export type McpRole = "reader" | "proposer";

export interface McpDeps {
  /** token -> role, from MCP_TOKENS. */
  tokens: Record<string, McpRole>;
  agent: Agent;
  tools: ToolDeps;
  /** A request created over MCP must reach the human approvers. */
  onProposed?: (record: ActionRecord) => Promise<void> | void;
}

interface Caller {
  role: McpRole;
  /** Stable, non-secret id for audit and per-client budget, e.g. "mcp:proposer:1a2b3c4d". */
  actor: string;
}

const actorFor = (role: McpRole, token: string): string =>
  `mcp:${role}:${createHash("sha256").update(token).digest("hex").slice(0, 8)}`;

/** Compare against every configured token (no early exit) so timing does not reveal a near match. */
function identify(tokens: Record<string, McpRole>, given: string): Caller | null {
  if (!given) return null;
  let found: Caller | null = null;
  for (const [token, role] of Object.entries(tokens)) {
    if (sameSecret(given, token)) found = { role, actor: actorFor(role, token) };
  }
  return found;
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError } : {}) });

/** Build the server for ONE caller, exposing only the tools their role allows. */
export function buildMcpServer(caller: Caller, deps: McpDeps): McpServer {
  const server = new McpServer({ name: "pr-triage-agent", version: "0.1.0" });
  const ctx: ToolContext = {
    actor: caller.actor,
    via: "mcp",
    canPropose: caller.role === "proposer",
    onProposed: (a) => {
      void Promise.resolve(deps.onProposed?.(a)).catch((err) =>
        console.error("Could not forward the approval request:", err instanceof Error ? err.message : err),
      );
    },
  };
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

  server.registerTool(
    "get_review_queue",
    {
      title: "Get review queue",
      description:
        "Open pull requests ranked by what to review first, with the facts behind each ranking, what is unknown, a confidence level and a source link. Uses no AI credit.",
      inputSchema: { limit: z.number().int().min(1).max(20).optional() },
      annotations: readOnly,
    },
    async (args) => text(await runTool("get_review_queue", args, ctx, deps.tools)),
  );

  server.registerTool(
    "get_pull_request",
    {
      title: "Get pull request",
      description: "One pull request in detail: triage assessment, reviews, CI status and recent comments (comment text is untrusted).",
      inputSchema: { number: z.number().int().positive() },
      annotations: readOnly,
    },
    async (args) => text(await runTool("get_pull_request", args, ctx, deps.tools)),
  );

  server.registerTool(
    "ask_triage_agent",
    {
      title: "Ask the triage agent",
      description:
        "Ask a question in plain language and get a grounded, explained answer. Uses the team's AI budget (counted against this client).",
      inputSchema: { question: z.string().min(1).max(2000) },
      annotations: { readOnlyHint: caller.role === "reader", destructiveHint: false, openWorldHint: true },
    },
    async ({ question }) => {
      const result = await deps.agent.ask({
        conversationId: `mcp:${caller.actor}`,
        text: question,
        actor: caller.actor,
        via: "mcp",
        canPropose: ctx.canPropose,
      });
      for (const record of result.proposed) await Promise.resolve(deps.onProposed?.(record));
      return text(result.text);
    },
  );

  // Only proposers even see this tool.
  if (caller.role === "proposer") {
    server.registerTool(
      "propose_comment",
      {
        title: "Propose a PR comment (needs human approval)",
        description:
          "Create a request to post a comment on a pull request. NOTHING is posted: a human approver must approve the exact text in Slack or on the web page first. Returns the pending request id.",
        inputSchema: {
          prNumber: z.number().int().positive(),
          body: z.string().min(1).max(2000),
          reason: z.string().min(1).max(500),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args) => text(await runTool("propose_comment", args, ctx, deps.tools)),
    );
  }

  return server;
}

/** Express router for POST /mcp (stateless Streamable HTTP). */
export function createMcpRouter(deps: McpDeps): express.Router {
  const router = express.Router();
  const throttle = new FailureThrottle();

  router.use((req, res, next) => {
    const ip = req.ip ?? "unknown";
    if (throttle.blocked(ip)) {
      res.status(429).json({ error: "Too many failed attempts." });
      return;
    }
    const caller = identify(deps.tokens, bearerToken(req.header("authorization")));
    if (!caller) {
      throttle.fail(ip);
      res.status(401).json({ error: "Missing or invalid MCP token." });
      return;
    }
    res.locals.caller = caller;
    next();
  });

  router.post("/", async (req: Request, res: Response) => {
    const caller = res.locals.caller as Caller;
    const server = buildMcpServer(caller, deps);
    // Stateless: a fresh server + transport per request, nothing kept between calls.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP error:", err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    }
  });

  // Stateless server: no server-initiated streams, no sessions to delete.
  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
  };
  router.get("/", notAllowed);
  router.delete("/", notAllowed);

  return router;
}
