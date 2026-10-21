import express from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { renderApprovalCard } from "../approvals/render.js";
import type { ApprovalService } from "../approvals/service.js";
import type { Agent } from "../agent/agent.js";
import type { BudgetService } from "../budget/service.js";
import { decide, renderQueue } from "../channels/shared.js";
import type { DecisionResult } from "../channels/shared.js";
import type { GitHubClient } from "../github/client.js";
import type { ActionRecord } from "../store/actions.js";
import { buildQueue } from "../triage/queue.js";
import { FailureThrottle, bearerToken, sameSecret } from "./throttle.js";
import { APP_JS, INDEX_HTML } from "./ui.js";

export type WebRole = "reader" | "approver";

export interface WebDeps {
  accessKey?: string;
  approverKey?: string;
  /** Actor id recorded when the approver key decides, e.g. "web:approver". */
  approverActor: string;
  agent: Agent;
  approvals: ApprovalService;
  github: Pick<GitHubClient, "listOpenPrs" | "getPr" | "repo">;
  budget: BudgetService;
  /** A request created from the web page: lets Slack approvers get the card too. */
  onProposed?: (record: ActionRecord) => Promise<void> | void;
  /** A decision taken on the web page: lets the requester be told. */
  onDecided?: (result: DecisionResult) => Promise<void> | void;
  /** Mount extra routes (the MCP endpoint) before the final error handler. */
  mount?: (app: express.Express) => void;
}

const chatBody = z.object({
  text: z.string().trim().min(1).max(2000),
  conversationId: z.string().regex(/^[\w-]{8,64}$/),
});
const idParam = z.string().regex(/^[\w-]{1,60}$/);

export function createWebApp(deps: WebDeps): express.Express {
  if (deps.accessKey && deps.approverKey && deps.accessKey === deps.approverKey) {
    throw new Error("WEB_ACCESS_KEY and WEB_APPROVER_KEY must be different.");
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "10kb" }));
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
    next();
  });

  app.get("/healthz", (_req, res) => void res.json({ ok: true }));
  app.get("/", (_req, res) => void res.type("html").send(INDEX_HTML));
  app.get("/app.js", (_req, res) => void res.type("js").send(APP_JS));

  // --- auth for /api ---
  const throttle = new FailureThrottle();
  const webEnabled = Boolean(deps.accessKey || deps.approverKey);

  const authenticate = (req: Request, res: Response, next: NextFunction): void => {
    if (!webEnabled) {
      res.status(503).json({ error: "The web interface is not enabled on this deployment." });
      return;
    }
    const ip = req.ip ?? "unknown";
    if (throttle.blocked(ip)) {
      res.status(429).json({ error: "Too many failed attempts. Try again in a few minutes." });
      return;
    }

    const key = bearerToken(req.header("authorization"));
    let role: WebRole | null = null;
    if (key) {
      if (deps.approverKey && sameSecret(key, deps.approverKey)) role = "approver";
      else if (deps.accessKey && sameSecret(key, deps.accessKey)) role = "reader";
    }
    if (!role) {
      throttle.fail(ip);
      res.status(401).json({ error: "Missing or wrong key." });
      return;
    }
    res.locals.role = role;
    next();
  };

  const requireApprover = (_req: Request, res: Response, next: NextFunction): void => {
    if (res.locals.role !== "approver") {
      res.status(403).json({ error: "This key cannot approve or reject. Use the approver key." });
      return;
    }
    next();
  };

  const api = express.Router();
  api.use(authenticate);

  api.get("/me", (_req, res) => void res.json({ role: res.locals.role, repo: deps.github.repo }));

  api.get("/queue", async (_req, res) => {
    const q = await buildQueue(deps.github);
    res.json({ queue: q, text: renderQueue(q) });
  });

  api.get("/budget", (_req, res) => void res.json(deps.budget.summary()));

  api.get("/actions", (_req, res) => {
    res.json({
      actions: deps.approvals.listRecent().map((a) => ({ ...a, card: renderApprovalCard(a) })),
    });
  });

  api.post("/chat", async (req, res) => {
    const parsed = chatBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Send { text (1-2000 chars), conversationId }." });
      return;
    }
    const role = res.locals.role as WebRole;
    const result = await deps.agent.ask({
      conversationId: `web:${parsed.data.conversationId}`,
      text: parsed.data.text,
      actor: role === "approver" ? deps.approverActor : "web:reader",
      via: "web",
      canPropose: true,
    });
    for (const record of result.proposed) {
      try {
        await deps.onProposed?.(record);
      } catch (err) {
        console.error("Could not forward the approval request:", err instanceof Error ? err.message : err);
      }
    }
    res.json({
      text: result.text,
      proposed: result.proposed.map((a) => ({ id: a.id, card: renderApprovalCard(a) })),
    });
  });

  const decideRoute = (kind: "approve" | "reject") => async (req: Request, res: Response) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "Bad action id." });
      return;
    }
    const result = await decide(deps.approvals, kind, id.data, deps.approverActor);
    try {
      await deps.onDecided?.(result);
    } catch (err) {
      console.error("Could not notify the requester:", err instanceof Error ? err.message : err);
    }
    res.status(result.record ? 200 : 409).json({ ok: result.ok, text: result.text });
  };
  api.post("/actions/:id/approve", requireApprover, decideRoute("approve"));
  api.post("/actions/:id/reject", requireApprover, decideRoute("reject"));

  app.use("/api", api);
  deps.mount?.(app);

  // Last resort: never leak internals or stack traces.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const bad = typeof err === "object" && err !== null && "type" in err && (err as { type: string }).type === "entity.parse.failed";
    if (!bad) console.error("Web error:", err instanceof Error ? err.message : err);
    res.status(bad ? 400 : 500).json({ error: bad ? "Invalid JSON." : "Something went wrong. Nothing was changed." });
  });

  return app;
}
