import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { renderApprovalCard } from "../approvals/render.js";
import type { ApprovalService } from "../approvals/service.js";
import type { Agent } from "../agent/agent.js";
import type { BudgetPort } from "../budget/service.js";
import { decide, renderQueue } from "../channels/shared.js";
import { personalView } from "../triage/personal.js";
import { buildGuide } from "../guide.js";
import type { DecisionResult } from "../channels/shared.js";
import type { GitHubReader } from "../github/port.js";
import { DIGEST_TASK } from "../scheduler/digest.js";
import { describeCron } from "../scheduler/describe.js";
import type { ActionRecord } from "../store/actions.js";
import type { RunRepository } from "../store/runs.js";
import { buildQueue } from "../triage/queue.js";
import type { QueueResult } from "../triage/queue.js";
import { SessionStore } from "./sessions.js";
import type { Principal } from "./sessions.js";
import { FailureThrottle, bearerToken, sameSecret } from "./throttle.js";
import { APP_JS, INDEX_HTML } from "./ui.js";

const SESSION_COOKIE = "sid";
/** Sent by the page on every change it asks for. A form on another site cannot add a custom header. */
const CSRF_HEADER = "pr-triage";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const loginBody = z.object({ key: z.string().min(1).max(200) });
/** Approve may carry the approver's corrected text. Reject ignores it. */
const decideBody = z.object({ body: z.string().max(2000).optional() }).default({});

function readCookie(req: Request, name: string): string {
  for (const part of (req.header("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return "";
      }
    }
  }
  return "";
}

export type WebRole = "reader" | "approver";

/** One person's own key. Recommended over the two shared keys: it names who did what and can be revoked alone. */
export interface WebUser {
  name: string;
  key: string;
  role: WebRole;
  github?: string;
}

export interface WebDeps {
  /** Per-person keys (WEB_USERS). */
  users?: WebUser[];
  /** Shared keys, kept so an existing deployment keeps working. Everyone holding one is the same person to the audit trail. */
  accessKey?: string;
  approverKey?: string;
  /** Actor id recorded when the shared approver key decides, e.g. "web:approver". */
  approverActor: string;
  /** How many reverse proxies sit in front (Fly.io: 1). Needed so the client address, and "is this HTTPS", are the real ones. */
  trustProxy?: number;
  /** Wrong keys allowed per address before a pause; 0 = never pause. Default 10. */
  maxFailures?: number;
  /** Sessions, injectable for tests. */
  sessions?: SessionStore;
  /** When set (and `sessions` is not), sessions are stored in SQLite so a restart keeps people signed in. */
  sessionDb?: DatabaseSync;
  agent: Agent;
  approvals: ApprovalService;
  github: GitHubReader;
  budget: Pick<BudgetPort, "summary">;
  /** A request created from the web page: lets Slack approvers get the card too. */
  onProposed?: (record: ActionRecord, replaced?: ActionRecord[]) => Promise<void> | void;
  /** A decision taken on the web page: lets the requester be told. */
  onDecided?: (result: DecisionResult) => Promise<void> | void;
  /** Mount extra routes (the MCP endpoint) before the final error handler. */
  mount?: (app: express.Express) => void;
  /** The scheduled digest, shown read-only so anyone can see that it ran. Omit to hide the panel's data. */
  digest?: DigestInfo;
}

/** What the page needs to show about the scheduled digest. It can only read; it cannot trigger a run. */
export interface DigestInfo {
  /** Cron expression, as configured (DIGEST_CRON). */
  cron: string;
  /** Time zone the expression is evaluated in. */
  timezone: string;
  /** Where the digest is delivered, in words (for people who are not in that channel). */
  target: string;
  /** Next firing time; null if the schedule is not running. Read live because the schedule starts after the web app is built. */
  nextRun: () => Date | null;
  runs: Pick<RunRepository, "recent">;
}

const chatBody = z.object({
  text: z.string().trim().min(1).max(2000),
  conversationId: z.string().regex(/^[\w-]{8,64}$/),
});
const idParam = z.string().regex(/^[\w-]{1,60}$/);

/** Changes whenever the page script changes, so browsers re-download it exactly when needed. */
const ASSET_VERSION = createHash("sha256").update(APP_JS).digest("hex").slice(0, 12);
const INDEX_VERSIONED = INDEX_HTML.replace('src="/app.js"', `src="/app.js?v=${ASSET_VERSION}"`);

/** The ranked queue costs one GitHub request per PR, so every tab and user shares one result for a short time. */
const QUEUE_TTL_MS = 60_000;
/** The Refresh button asks for fresh data, but not more than once per this interval. */
const QUEUE_MIN_REFRESH_MS = 10_000;

export function createWebApp(deps: WebDeps): express.Express {
  if (deps.accessKey && deps.approverKey && deps.accessKey === deps.approverKey) {
    throw new Error("WEB_ACCESS_KEY and WEB_APPROVER_KEY must be different.");
  }

  // Everything that can sign in: each person's own key, plus the two shared keys if they are configured.
  const credentials: Array<{ key: string; principal: Principal }> = [
    ...(deps.users ?? []).map((u) => ({
      key: u.key,
      principal: {
        name: u.name,
        role: u.role,
        actor: `web:${u.name}`,
        ...(u.github ? { githubLogin: u.github } : {}),
      },
    })),
    ...(deps.approverKey
      ? [{ key: deps.approverKey, principal: { name: "shared approver key", role: "approver" as const, actor: deps.approverActor } }]
      : []),
    ...(deps.accessKey
      ? [{ key: deps.accessKey, principal: { name: "shared access key", role: "reader" as const, actor: "web:reader" } }]
      : []),
  ];
  if (new Set(credentials.map((c) => c.key)).size !== credentials.length) {
    throw new Error("Web keys must all be different (WEB_USERS, WEB_ACCESS_KEY and WEB_APPROVER_KEY share a value).");
  }
  if (new Set(credentials.map((c) => c.principal.actor)).size !== credentials.length) {
    throw new Error("Web user names must be unique.");
  }

  /** Compare against every key (no early exit) so timing does not reveal a near match. */
  const identify = (given: string): Principal | null => {
    if (!given) return null;
    let found: Principal | null = null;
    for (const c of credentials) if (sameSecret(given, c.key)) found = c.principal;
    return found;
  };
  const sessions = deps.sessions ?? new SessionStore({ db: deps.sessionDb });

  const app = express();
  app.disable("x-powered-by");
  // Behind a reverse proxy (Fly.io) every request would otherwise appear to come from the proxy: the lockout
  // would then lock out everyone together, and the cookie would not know the connection is HTTPS.
  if (deps.trustProxy) app.set("trust proxy", deps.trustProxy);
  app.use(express.json({ limit: "10kb" }));
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
    next();
  });

  app.get("/healthz", (_req, res) => void res.json({ ok: true }));
  // The page always asks the server whether it changed (cheap: it is tiny). The script is addressed by a
  // hash of its content, so it can be cached for a year and is fetched again only when the code changes.
  // Result: a new deploy shows up on the next normal page load, with no hard refresh needed.
  app.get("/", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.type("html").send(INDEX_VERSIONED);
  });
  app.get("/app.js", (req, res) => {
    res.setHeader("Cache-Control", req.query.v === ASSET_VERSION ? "public, max-age=31536000, immutable" : "no-cache");
    res.type("js").send(APP_JS);
  });

  // --- auth for /api ---
  const throttle = new FailureThrottle(deps.maxFailures);
  const webEnabled = credentials.length > 0;

  // Sign in once with your key; the browser then holds only a random session id in an HttpOnly cookie
  // (not readable by page scripts, never sent to other sites, HTTPS-only when the connection is HTTPS).
  app.post("/api/login", (req, res) => {
    if (!webEnabled) {
      res.status(503).json({ error: "The web interface is not enabled on this deployment." });
      return;
    }
    const ip = req.ip ?? "unknown";
    const parsed = loginBody.safeParse(req.body);
    const principal = parsed.success ? identify(parsed.data.key) : null;
    if (!principal) {
      if (throttle.blocked(ip)) {
        res.status(429).json({ error: "Too many failed attempts. Try again in a few minutes." });
        return;
      }
      throttle.fail(ip);
      res.status(401).json({ error: "Wrong key." });
      return;
    }
    const id = sessions.create(principal);
    res.cookie(SESSION_COOKIE, id, {
      httpOnly: true,
      sameSite: "strict",
      secure: req.secure,
      path: "/api",
      maxAge: sessions.maxAgeMs,
    });
    res.setHeader("Cache-Control", "no-store");
    res.json({ role: principal.role, name: principal.name, repo: deps.github.repo });
  });

  app.post("/api/logout", (req, res) => {
    const id = readCookie(req, SESSION_COOKIE);
    if (id) sessions.destroy(id);
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "strict", secure: req.secure, path: "/api" });
    res.json({ ok: true });
  });

  const authenticate = (req: Request, res: Response, next: NextFunction): void => {
    if (!webEnabled) {
      res.status(503).json({ error: "The web interface is not enabled on this deployment." });
      return;
    }
    const ip = req.ip ?? "unknown";

    // Programs (and tests) may send the key as a Bearer header; the page uses its session cookie.
    const key = bearerToken(req.header("authorization"));
    let principal: Principal | null = null;
    let viaCookie = false;
    if (key) {
      principal = identify(key);
    } else {
      const id = readCookie(req, SESSION_COOKIE);
      if (id) {
        principal = sessions.get(id);
        viaCookie = principal !== null;
      }
    }
    if (!principal) {
      // Only a wrong key counts against the lockout. A valid session or key is never locked out:
      // testers on a shared office IP must still be able to use the page after someone else's typos.
      if (throttle.blocked(ip)) {
        res.status(429).json({ error: "Too many failed attempts. Try again in a few minutes." });
        return;
      }
      if (key) throttle.fail(ip);
      res.status(401).json({ error: key ? "Wrong key." : "Not signed in." });
      return;
    }
    // A browser attaches cookies by itself, so a change made with one must prove it came from our page.
    if (viaCookie && !SAFE_METHODS.has(req.method) && req.header("x-requested-with") !== CSRF_HEADER) {
      res.status(403).json({ error: "Missing request header." });
      return;
    }
    res.locals.principal = principal;
    res.locals.role = principal.role;
    next();
  };

  const requireApprover = (_req: Request, res: Response, next: NextFunction): void => {
    if (res.locals.role !== "approver") {
      res.status(403).json({ error: "Your key cannot approve or reject. Ask for an approver key." });
      return;
    }
    next();
  };

  const api = express.Router();
  api.use(authenticate);
  // Answers can contain private PR data: never let a browser or proxy keep a copy.
  api.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  api.get("/me", (_req, res) => {
    const p = res.locals.principal as Principal;
    res.json({ role: p.role, name: p.name, repo: deps.github.repo, githubLogin: p.githubLogin ?? null });
  });

  // What this key may and may not do. Written for the caller's role, from the same source as Slack's help.
  api.get("/guide", (_req, res) => {
    res.json(buildGuide(res.locals.role === "approver" ? "approver" : "requester", { channel: "web" }));
  });

  // One shared copy of the queue. Simultaneous requests wait for the same GitHub round trip.
  let queueCache: { at: number; value: QueueResult } | undefined;
  let queueInflight: Promise<QueueResult> | undefined;
  const sharedQueue = async (force: boolean): Promise<{ queue: QueueResult; cached: boolean }> => {
    const age = queueCache ? Date.now() - queueCache.at : Number.POSITIVE_INFINITY;
    if (queueCache && age < (force ? QUEUE_MIN_REFRESH_MS : QUEUE_TTL_MS)) {
      return { queue: queueCache.value, cached: true };
    }
    queueInflight ??= buildQueue(deps.github)
      .then(async (value) => {
        queueCache = { at: Date.now(), value };
        const dropped = await deps.approvals.dropStalePending();
        if (dropped.length > 0) {
          const gone = new Set(dropped.map((a) => a.prNumber));
          if (value.items.some((i) => gone.has(i.number))) queueCache = undefined;
        }
        return value;
      })
      .finally(() => {
        queueInflight = undefined;
      });
    return { queue: await queueInflight, cached: false };
  };

  api.get("/queue", async (req, res) => {
    const q = await sharedQueue(req.query.refresh === "1");
    const login = (res.locals.principal as Principal).githubLogin;
    res.json({
      queue: q.queue,
      text: renderQueue(q.queue, login ? { login } : undefined),
      cached: q.cached,
      you: login ? personalView(q.queue.items, login) : null,
    });
  });

  api.get("/budget", (_req, res) => void res.json(deps.budget.summary()));

  // Read-only: whether the scheduled digest ran, how it went and what it sent. Same for every role.
  api.get("/digest", (_req, res) => {
    const d = deps.digest;
    if (!d) {
      res.json({ enabled: false });
      return;
    }
    res.json({
      enabled: true,
      cron: d.cron,
      /** The same schedule in words, e.g. "Weekdays at 08:30". The raw cron stays available for tooltips. */
      schedule: describeCron(d.cron),
      timezone: d.timezone,
      target: d.target,
      nextRun: d.nextRun()?.toISOString() ?? null,
      runs: d.runs.recent(DIGEST_TASK, 10),
    });
  });

  api.get("/actions", async (_req, res) => {
    const dropped = await deps.approvals.dropStalePending();
    if (dropped.length > 0 && queueCache) {
      const gone = new Set(dropped.map((a) => a.prNumber));
      if (queueCache.value.items.some((i) => gone.has(i.number))) queueCache = undefined;
    }
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
    const principal = res.locals.principal as Principal;
    const result = await deps.agent.ask({
      conversationId: `web:${principal.actor}:${parsed.data.conversationId}`,
      text: parsed.data.text,
      actor: principal.actor,
      via: "web",
      canPropose: true,
      githubLogin: principal.githubLogin,
    });
    for (const record of result.proposed) {
      try {
        const mine = result.replaced.filter((a) => a.prNumber === record.prNumber);
        await deps.onProposed?.(record, mine);
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
    const parsed = decideBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "The edited comment must be text of at most 2000 characters." });
      return;
    }
    const result = await decide(
      deps.approvals,
      kind,
      id.data,
      (res.locals.principal as Principal).actor,
      kind === "approve" ? parsed.data.body : undefined,
    );
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
