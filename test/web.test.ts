import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalService } from "../src/approvals/service.js";
import { BudgetService } from "../src/budget/service.js";
import { ActionRepository } from "../src/store/actions.js";
import { openDatabase } from "../src/store/db.js";
import type { RunRecord } from "../src/store/runs.js";
import { createWebApp } from "../src/web/server.js";
import type { DigestInfo } from "../src/web/server.js";
import { SessionStore } from "../src/web/sessions.js";
import { APP_JS, INDEX_HTML } from "../src/web/ui.js";

const READER = "reader-key-0123456789";
const APPROVER = "approver-key-0123456789";
const APPROVER_ACTOR = "web:approver";

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

const DANA = "dana-personal-key-0123456";
const LEE = "lee-personal-key-012345678";
const USERS = [
  { name: "dana", key: DANA, role: "approver" as const },
  { name: "lee", key: LEE, role: "reader" as const },
];

async function start(
  over: { accessKey?: string; approverKey?: string; users?: Array<{ name: string; key: string; role: "reader" | "approver"; github?: string }>; trustProxy?: number; sessions?: SessionStore; maxFailures?: number; digest?: DigestInfo } = {
    accessKey: READER,
    approverKey: APPROVER,
  },
) {
  const db = openDatabase(":memory:");
  const github = {
    repo: "acme/app",
    listOpenPrs: vi.fn(async () => [] as never),
    getPr: vi.fn(),
    getPrSummary: vi.fn(
      async (
        n: number,
      ): Promise<{
        number: number;
        title: string;
        sourceUrl: string;
        state?: "open" | "closed";
        merged?: boolean;
        locked?: boolean;
      }> => ({ number: n, title: "Fix login", sourceUrl: `https://github.com/acme/app/pull/${n}` }),
    ),
    postComment: vi.fn(async () => ({ id: 1, url: "https://github.com/acme/app/pull/7#c1" })),
    findCommentWithMarker: vi.fn(async () => null),
  };
  const approvals = new ApprovalService({
    github: github as never,
    repo: new ActionRepository(db),
    isApprover: (id) => id === APPROVER_ACTOR || id === "web:dana",
  });
  const budget = new BudgetService({
    db,
    monthlyBudgetUsd: 50,
    hostingUsd: 7,
    pricePerMInput: 0.15,
    pricePerMOutput: 0.6,
    dailyRequestsPerActor: 40,
  });
  const agent = { ask: vi.fn(async () => ({ text: "Review #7 first.", proposed: [] as never[], replaced: [] as never[] })) };
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
  const call = (path: string, init: { key?: string; method?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) =>
    fetch(base + path, {
      method: init.method ?? (init.body !== undefined || init.raw !== undefined ? "POST" : "GET"),
      headers: {
        "Content-Type": "application/json",
        ...(init.key ? { Authorization: `Bearer ${init.key}` } : {}),
        ...init.headers,
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

  it("has a Guide button in the top bar that opens a centred popup, closable by button, backdrop and Escape", () => {
    const bar = INDEX_HTML.slice(INDEX_HTML.indexOf('<header class="bar">'), INDEX_HTML.indexOf("</header>"));
    expect(bar).toContain('id="guideBtn"');
    expect(INDEX_HTML).toMatch(/id="guideModal"[\s\S]*role="dialog"[\s\S]*aria-modal="true"/);
    expect(APP_JS).toMatch(/\$\("guideBtn"\)\.onclick = openGuide/);
    expect(APP_JS).toMatch(/e\.target === \$\("guideModal"\)/);
    expect(APP_JS).toMatch(/guideIsOpen\(\)\) closeGuide\(\)/);
  });

  it("the page never stores the key: it signs in once and relies on the HttpOnly cookie", () => {
    expect(APP_JS).not.toMatch(/sessionStorage\.(get|set)Item\("key"/);
    expect(APP_JS).not.toMatch(/localStorage\.setItem\("key"/);
    expect(APP_JS).not.toMatch(/Authorization/);
    expect(APP_JS).toMatch(/"\/api\/login"/);
    expect(APP_JS).toMatch(/X-Requested-With/);
  });

  it("the page script never uses innerHTML (untrusted text is written as text only)", () => {
    expect(APP_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it("leaves a gap between chat detail labels and their values", () => {
    expect(INDEX_HTML).toMatch(/ul ul li\.kv \{[^}]*column-gap: 16px/);
    expect(INDEX_HTML).toMatch(/grid-template-columns: max-content minmax\(0, 1fr\)/);
    expect(INDEX_HTML).not.toMatch(/grid-template-columns: 132px/);
  });

  it("keeps one ranked list when the model writes 1. then unindented dashes", () => {
    expect(APP_JS).toMatch(/A blank line inside a ranked list must not start a new <ol>/);
    expect(APP_JS).toMatch(/isBullet && lastLi && \(indent >= 2 \|\| ordered\)/);
    expect(APP_JS).not.toMatch(/if \(!list \|\| ordered !== isNumbered\)/);
  });

  it("labels a withdrawn request as no longer open when the PR closed", () => {
    expect(APP_JS).toMatch(/function prGone\(error\)/);
    expect(APP_JS).toMatch(/status\.prGone/);
    expect(APP_JS).toMatch(/flowChart\(a\.status, a\.error\)/);
  });

  it("folds a long ranked list after 3 items and reveals more in chunks", () => {
    expect(APP_JS).toMatch(/var LIST_PREVIEW = 3/);
    expect(APP_JS).toMatch(/var LIST_STEP = 5/);
    expect(APP_JS).toMatch(/foldLists\(box\)/);
    expect(APP_JS).toMatch(/Show " \+ n \+ " more \(" \+ left \+ " hidden\)/);
    expect(INDEX_HTML).toMatch(/button\.more-prs/);
  });

  it("send() does not shadow the i18n helper, so the first question actually fires", () => {
    expect(APP_JS).toMatch(/var msg = \$\("text"\)\.value\.trim\(\)/);
    expect(APP_JS).toMatch(/bubble\("bot typing", t\("chat.checking"\)\)/);
    expect(APP_JS).not.toMatch(/function send\(\) \{\s*var t = /);
  });

  it("the chat box caps questions at 2000 characters and does not silently drop Confirm", () => {
    expect(INDEX_HTML).toMatch(/id="text"[^>]*maxlength="2000"/);
    expect(APP_JS).toMatch(/CHAT_MAX = 2000/);
    expect(APP_JS).toMatch(/Keep the question under /);
    expect(APP_JS).not.toMatch(/setTimeout\(disarm, 8000\)/);
    expect(APP_JS).toMatch(/stay armed until they confirm or Cancel/);
  });

  it("keeps the chat after an idle 401, confirms Reject, and ignores IME Enter", () => {
    expect(APP_JS).toMatch(/session.expired/);
    expect(APP_JS).not.toMatch(/if \(path !== "\/api\/login"\) signOut\(false\)/);
    expect(APP_JS).toMatch(/armedKind === "reject"/);
    expect(APP_JS).toMatch(/e.isComposing/);
    expect(APP_JS).toMatch(/refreshIfStale\(\);/);
    expect(INDEX_HTML).not.toMatch(/id="lang"/);
    expect(APP_JS).not.toMatch(/"he"/);
    expect(APP_JS).toMatch(/var I18N = /);
  });
});

describe("caching: a deploy shows up without a hard refresh", () => {
  it("revalidates the page, and caches the script for a year under a content-hash address", async () => {
    const { call } = await start();
    const page = await call("/");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    const html = await page.text();
    const src = /src="(\/app\.js\?v=[0-9a-f]{12})"/.exec(html)?.[1];
    expect(src).toBeDefined();

    const script = await call(src as string);
    expect(script.status).toBe(200);
    expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

    // A wrong or missing version must never be cached for long (it could pin an old script).
    expect((await call("/app.js?v=000000000000")).headers.get("cache-control")).toBe("no-cache");
    expect((await call("/app.js")).headers.get("cache-control")).toBe("no-cache");
  });

  it("never lets a browser keep API answers", async () => {
    const { call } = await start();
    expect((await call("/api/me", { key: READER })).headers.get("cache-control")).toBe("no-store");
  });
});

describe("the shared review queue", () => {
  it("asks GitHub once for simultaneous and repeated requests within a minute", async () => {
    const { call, github } = await start();
    await Promise.all([call("/api/queue", { key: READER }), call("/api/queue", { key: APPROVER }), call("/api/queue", { key: READER })]);
    await call("/api/queue", { key: READER });
    expect(github.listOpenPrs).toHaveBeenCalledTimes(1);
  });

  it("lets Refresh ask for fresh data, but not more than once every few seconds", async () => {
    const { call, github } = await start();
    const first = await (await call("/api/queue", { key: READER })).json();
    expect(first.cached).toBe(false);
    const again = await (await call("/api/queue", { key: READER })).json();
    expect(again.cached).toBe(true);
    await call("/api/queue?refresh=1", { key: READER });
    const refresh = await (await call("/api/queue?refresh=1", { key: READER })).json();
    expect(refresh.cached).toBe(true);
    expect(github.listOpenPrs).toHaveBeenCalledTimes(1); // both Refresh clicks landed inside the 10 s window
  });

  it("the refresh toast does not claim a fresh GitHub read when the cache was served", () => {
    expect(APP_JS).toMatch(/Queue is already up to date/);
  });

  it("refreshes after the cache expires, and does not cache a failure", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { call, github } = await start();
      github.listOpenPrs.mockRejectedValueOnce(new Error("GitHub is down"));
      expect((await call("/api/queue", { key: READER })).status).toBe(500);
      expect((await call("/api/queue", { key: READER })).status).toBe(200); // the failure was not kept
      expect(github.listOpenPrs).toHaveBeenCalledTimes(2);

      vi.setSystemTime(Date.now() + 61_000);
      await call("/api/queue", { key: READER });
      expect(github.listOpenPrs).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the page refreshes quietly when you come back to a stale tab, and warns when the list is old", () => {
    expect(APP_JS).toMatch(/addEventListener\("visibilitychange", refreshIfStale\)/);
    expect(APP_JS).toMatch(/quiet: true/);
    expect(APP_JS).toMatch(/may be outdated/);
    expect(APP_JS).toMatch(/\/api\/queue\?refresh=1/);
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

  it("locks out further guesses after repeated wrong keys, but a valid key still works", async () => {
    const { call } = await start();
    for (let i = 0; i < 10; i += 1) await call("/api/me", { key: "wrong-wrong-wrong-0" });
    expect((await call("/api/me", { key: "wrong-wrong-wrong-0" })).status).toBe(429);
    expect((await call("/api/me", { key: READER })).status).toBe(200);
  });

  it("a valid session cookie is not locked out by other people's wrong keys on the same address", async () => {
    const { call } = await start();
    const { cookie } = await (async () => {
      const res = await call("/api/login", { body: { key: READER } });
      const set = res.headers.get("set-cookie") ?? "";
      return { cookie: set.split(";")[0] ?? "" };
    })();
    for (let i = 0; i < 10; i += 1) await call("/api/me", { key: "wrong-wrong-wrong-0" });
    expect((await call("/api/me", { key: "wrong-wrong-wrong-0" })).status).toBe(429);
    expect((await call("/api/me", { headers: { Cookie: cookie } })).status).toBe(200);
  });

  it("never pauses an address when the lockout is turned off (maxFailures 0)", async () => {
    const { call } = await start({ accessKey: READER, approverKey: APPROVER, maxFailures: 0 });
    for (let i = 0; i < 25; i += 1) await call("/api/me", { key: "wrong-wrong-wrong-0" });
    expect((await call("/api/me", { key: READER })).status).toBe(200);
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

describe("signing in with a session cookie", () => {
  const CSRF = { "X-Requested-With": "pr-triage" };

  /** Log in and return the cookie header a browser would send back. */
  async function login(call: Awaited<ReturnType<typeof start>>["call"], key: string) {
    const res = await call("/api/login", { body: { key } });
    const set = res.headers.get("set-cookie") ?? "";
    return { res, set, cookie: set.split(";")[0] ?? "" };
  }

  it("a right key starts a session in an HttpOnly, same-site cookie, and the key is not needed again", async () => {
    const { call } = await start();
    const { res, set, cookie } = await login(call, APPROVER);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: "approver", repo: "acme/app" });
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Strict/i);
    expect(set).toMatch(/Path=\/api/);
    expect(set).not.toContain(APPROVER); // the cookie holds a random id, never the key
    expect(res.headers.get("cache-control")).toBe("no-store");

    const me = await call("/api/me", { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ role: "approver" });
  });

  it("a wrong key is refused, sets no cookie, and counts toward the lockout", async () => {
    const { call } = await start();
    const bad = await login(call, "wrong-wrong-wrong-0");
    expect(bad.res.status).toBe(401);
    expect(bad.set).toBe("");
    for (let i = 0; i < 9; i += 1) await login(call, "wrong-wrong-wrong-0");
    expect((await login(call, "wrong-wrong-wrong-0")).res.status).toBe(429);
    expect((await login(call, READER)).res.status).toBe(200);
  });

  it("opening the page without a session is not counted as an attack", async () => {
    const { call } = await start();
    for (let i = 0; i < 15; i += 1) expect((await call("/api/me")).status).toBe(401);
    expect((await login(call, READER)).res.status).toBe(200);
  });

  it("a changing request over a cookie must carry the page's header (blocks cross-site forms)", async () => {
    const { call, agent } = await start();
    const { cookie } = await login(call, READER);
    const body = { text: "what first?", conversationId: "abcdefgh-1234" };
    expect((await call("/api/chat", { body, headers: { Cookie: cookie } })).status).toBe(403);
    expect(agent.ask).not.toHaveBeenCalled();
    expect((await call("/api/chat", { body, headers: { Cookie: cookie, ...CSRF } })).status).toBe(200);
  });

  it("logout ends the session on the server, so a copied cookie stops working", async () => {
    const { call } = await start();
    const { cookie } = await login(call, READER);
    expect((await call("/api/me", { headers: { Cookie: cookie } })).status).toBe(200);
    const out = await call("/api/logout", { method: "POST", body: {}, headers: { Cookie: cookie } });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(/sid=;/);
    expect((await call("/api/me", { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it("a session ends after sitting idle, and after the maximum age", async () => {
    let now = 1_000_000;
    const sessions = new SessionStore({ idleMs: 60_000, maxAgeMs: 300_000, now: () => now });
    const { call } = await start({ accessKey: READER, approverKey: APPROVER, sessions });
    const { cookie } = await login(call, READER);

    now += 50_000;
    expect((await call("/api/me", { headers: { Cookie: cookie } })).status).toBe(200); // activity keeps it alive
    now += 50_000;
    expect((await call("/api/me", { headers: { Cookie: cookie } })).status).toBe(200);
    now += 70_000; // idle too long
    expect((await call("/api/me", { headers: { Cookie: cookie } })).status).toBe(401);

    const second = await login(call, READER);
    for (let i = 0; i < 5; i += 1) {
      now += 55_000; // always active, but the maximum age still ends it
      await call("/api/me", { headers: { Cookie: second.cookie } });
    }
    now += 55_000;
    expect((await call("/api/me", { headers: { Cookie: second.cookie } })).status).toBe(401);
  });

  it("marks the cookie Secure when the connection is HTTPS behind a trusted proxy", async () => {
    const { call } = await start({ accessKey: READER, trustProxy: 1 });
    const res = await call("/api/login", { body: { key: READER }, headers: { "X-Forwarded-Proto": "https" } });
    expect(res.headers.get("set-cookie")).toMatch(/Secure/i);
    const plain = await call("/api/login", { body: { key: READER } });
    expect(plain.headers.get("set-cookie")).not.toMatch(/Secure/i);
  });

  it("with a trusted proxy, lockout counts each real client address, not the proxy", async () => {
    const { call } = await start({ accessKey: READER, trustProxy: 1 });
    const from = (ip: string) => ({ "X-Forwarded-For": ip });
    for (let i = 0; i < 10; i += 1) await call("/api/login", { body: { key: "wrong-wrong-wrong-0" }, headers: from("203.0.113.9") });
    expect((await call("/api/login", { body: { key: "wrong-wrong-wrong-0" }, headers: from("203.0.113.9") })).status).toBe(429);
    expect((await call("/api/login", { body: { key: READER }, headers: from("203.0.113.9") })).status).toBe(200);
    expect((await call("/api/login", { body: { key: "wrong-wrong-wrong-0" }, headers: from("198.51.100.4") })).status).toBe(401);
  });
});

describe("a key for each person", () => {
  it("signs people in under their own name and role", async () => {
    const { call } = await start({ users: USERS });
    expect(await (await call("/api/me", { key: DANA })).json()).toMatchObject({ role: "approver", name: "dana" });
    expect(await (await call("/api/me", { key: LEE })).json()).toMatchObject({ role: "reader", name: "lee" });
  });

  it("records what each person did under their own identity", async () => {
    const { call, agent } = await start({ users: USERS });
    await call("/api/chat", { key: LEE, body: { text: "what first?", conversationId: "abcdefgh-1234" } });
    expect(agent.ask).toHaveBeenCalledWith(expect.objectContaining({ actor: "web:lee" }));
  });

  it("groups the queue for a person whose WEB_USERS entry has a GitHub login", async () => {
    const users = [
      { name: "dana", key: DANA, role: "approver" as const, github: "octocat" },
      { name: "lee", key: LEE, role: "reader" as const },
    ];
    const { call, agent } = await start({ users });
    expect(await (await call("/api/me", { key: DANA })).json()).toMatchObject({ githubLogin: "octocat" });
    expect(await (await call("/api/me", { key: LEE })).json()).toMatchObject({ githubLogin: null });
    const queue = await (await call("/api/queue", { key: DANA })).json();
    expect(queue.you).toMatchObject({ login: "octocat", forYou: [], yours: [], others: [] });
    expect(await (await call("/api/queue", { key: LEE })).json()).toMatchObject({ you: null });
    await call("/api/chat", { key: DANA, body: { text: "what first?", conversationId: "abcdefgh-1234" } });
    expect(agent.ask).toHaveBeenCalledWith(expect.objectContaining({ githubLogin: "octocat" }));
  });

  it("keeps a session across SessionStore instances that share a database", () => {
    const db = openDatabase(":memory:");
    const first = new SessionStore({ db });
    const id = first.create({ name: "dana", role: "approver", actor: "web:dana", githubLogin: "octocat" });
    expect(new SessionStore({ db }).get(id)).toMatchObject({ actor: "web:dana", githubLogin: "octocat" });
  });

  it("keeps each person's conversation separate, even with the same conversation id", async () => {
    const { call, agent } = await start({ users: USERS });
    const body = { text: "hi", conversationId: "abcdefgh-1234" };
    await call("/api/chat", { key: LEE, body });
    await call("/api/chat", { key: DANA, body });
    const ids = agent.ask.mock.calls.map((c) => (c as unknown as [{ conversationId: string }])[0].conversationId);
    expect(new Set(ids).size).toBe(2);
  });

  it("an approver-role person can approve, a reader-role person cannot, and the audit names the approver", async () => {
    const { call, approvals, github } = await start({ users: USERS });
    const rec = (await approvals.propose({ prNumber: 7, body: "Please fix CI", reason: "CI red", requestedBy: "web:lee", via: "web" })).record;
    expect((await call(`/api/actions/${rec.id}/approve`, { key: LEE, method: "POST", body: {} })).status).toBe(403);
    expect(github.postComment).not.toHaveBeenCalled();
    expect((await call(`/api/actions/${rec.id}/approve`, { key: DANA, method: "POST", body: {} })).status).toBe(200);
    expect(github.postComment).toHaveBeenCalledTimes(1);
    expect(approvals.get(rec.id)?.decidedBy).toBe("web:dana");
  });

  it("an approver can correct the text while approving; the corrected text is what is posted", async () => {
    const { call, approvals, github } = await start({ users: USERS });
    const rec = (await approvals.propose({ prNumber: 7, body: "Original draft", reason: "r", requestedBy: "web:lee", via: "web" })).record;
    const res = await call(`/api/actions/${rec.id}/approve`, { key: DANA, method: "POST", body: { body: "Corrected by Dana" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { text: string }).text).toMatch(/edited comment/);
    expect((github.postComment.mock.calls[0] as unknown as [number, string])[1]).toMatch(/^Corrected by Dana/);
    expect(approvals.get(rec.id)).toMatchObject({ body: "Corrected by Dana", originalBody: "Original draft", decidedBy: "web:dana" });
  });

  it("a reader cannot use the edit field to change anything", async () => {
    const { call, approvals, github } = await start({ users: USERS });
    const rec = (await approvals.propose({ prNumber: 7, body: "Original draft", reason: "r", requestedBy: "web:lee", via: "web" })).record;
    expect((await call(`/api/actions/${rec.id}/approve`, { key: LEE, method: "POST", body: { body: "Hijacked" } })).status).toBe(403);
    expect(github.postComment).not.toHaveBeenCalled();
    expect(approvals.get(rec.id)).toMatchObject({ status: "pending", body: "Original draft", originalBody: null });
  });

  it("refuses a malformed or empty edit without posting, and the request stays pending", async () => {
    const { call, approvals, github } = await start({ users: USERS });
    const rec = (await approvals.propose({ prNumber: 7, body: "Original draft", reason: "r", requestedBy: "web:lee", via: "web" })).record;
    expect((await call(`/api/actions/${rec.id}/approve`, { key: DANA, method: "POST", body: { body: 42 } })).status).toBe(400);
    expect((await call(`/api/actions/${rec.id}/approve`, { key: DANA, method: "POST", body: { body: "   " } })).status).toBe(409);
    expect(github.postComment).not.toHaveBeenCalled();
    expect(approvals.get(rec.id)?.status).toBe("pending");
  });

  it("rejecting ignores any edit text", async () => {
    const { call, approvals, github } = await start({ users: USERS });
    const rec = (await approvals.propose({ prNumber: 7, body: "Original draft", reason: "r", requestedBy: "web:lee", via: "web" })).record;
    expect((await call(`/api/actions/${rec.id}/reject`, { key: DANA, method: "POST", body: { body: "Ignored" } })).status).toBe(200);
    expect(github.postComment).not.toHaveBeenCalled();
    expect(approvals.get(rec.id)).toMatchObject({ status: "rejected", body: "Original draft", originalBody: null });
  });
  it("refuses to start when two people (or a person and a shared key) have the same key or name", () => {
    const base = { approverActor: APPROVER_ACTOR, agent: {} as never, approvals: {} as never, github: {} as never, budget: {} as never };
    expect(() => createWebApp({ ...base, users: [USERS[0]!, { ...USERS[1]!, key: DANA }] })).toThrow(/must all be different/);
    expect(() => createWebApp({ ...base, users: [USERS[0]!], accessKey: DANA })).toThrow(/must all be different/);
    expect(() => createWebApp({ ...base, users: [USERS[0]!, { ...USERS[1]!, name: "dana" }] })).toThrow(/unique/);
    expect(() => createWebApp({ ...base, users: [{ name: "approver", key: DANA, role: "reader" }], approverKey: APPROVER })).toThrow(/unique/);
  });

  it("works with only per-person keys, and shared keys are optional", async () => {
    const { call } = await start({ users: USERS });
    expect((await call("/api/me", { key: READER })).status).toBe(401);
    expect((await call("/api/me", { key: DANA })).status).toBe(200);
  });
});

describe("guide", () => {
  it("needs a key, and tells each key what it may and may not do", async () => {
    const { call } = await start();
    expect((await call("/api/guide")).status).toBe(401);

    const reader = await (await call("/api/guide", { key: READER })).json();
    expect(reader.youAre).toMatch(/cannot approve/i);
    expect(JSON.stringify(reader)).not.toMatch(/approve or reject a comment request/i);

    const approver = await (await call("/api/guide", { key: APPROVER })).json();
    expect(approver.youAre).toMatch(/APPROVER/);
    expect(JSON.stringify(approver)).toMatch(/Approvals panel/);
    for (const g of [reader, approver]) {
      expect(JSON.stringify(g)).toMatch(/never posts, merges, closes, approves or edits/i);
    }
  });
});

describe("scheduled digest status", () => {
  const run = (over: Partial<RunRecord> = {}): RunRecord => ({
    id: 1,
    task: "digest",
    startedAt: "2026-10-22T05:30:00.000Z",
    finishedAt: "2026-10-22T05:30:02.000Z",
    ok: true,
    error: null,
    text: "PR digest for acme/app",
    ...over,
  });
  const info = (runs: RunRecord[], nextRun: Date | null = new Date("2026-10-23T05:30:00.000Z")): DigestInfo => ({
    cron: "30 8 * * 0-5",
    timezone: "Asia/Jerusalem",
    target: "Slack digest channel",
    nextRun: () => nextRun,
    runs: { recent: vi.fn(() => runs) },
  });

  it("needs a key, like every other API route", async () => {
    const { call } = await start({ accessKey: READER, approverKey: APPROVER, digest: info([]) });
    expect((await call("/api/digest")).status).toBe(401);
  });

  it("shows the schedule, the next run, where it goes and the recorded runs, to a reader too", async () => {
    const runs = [run({ id: 2 }), run({ id: 1, ok: false, error: "GitHub rate limit reached.", text: "" })];
    const { call } = await start({ accessKey: READER, approverKey: APPROVER, digest: info(runs) });
    const res = await call("/api/digest", { key: READER });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      enabled: true,
      cron: "30 8 * * 0-5",
      schedule: "Weekdays at 08:30",
      timezone: "Asia/Jerusalem",
      target: "Slack digest channel",
      nextRun: "2026-10-23T05:30:00.000Z",
    });
    expect(body.runs).toHaveLength(2);
    expect(body.runs[0]).toMatchObject({ ok: true, text: "PR digest for acme/app" });
    expect(body.runs[1]).toMatchObject({ ok: false, error: "GitHub rate limit reached." });
  });

  it("says there is no next run when the schedule is not running, and has no way to trigger a run", async () => {
    const { call } = await start({ accessKey: READER, approverKey: APPROVER, digest: info([], null) });
    expect((await (await call("/api/digest", { key: READER })).json()).nextRun).toBeNull();
    // Read-only on purpose: a run posts to the team channel, so the web page cannot start one.
    expect((await call("/api/digest", { key: APPROVER, method: "POST", body: {} })).status).toBe(404);
  });

  it("reports enabled: false when no digest is configured", async () => {
    const { call } = await start();
    expect(await (await call("/api/digest", { key: READER })).json()).toEqual({ enabled: false });
  });

  it("the page shows it with text only, and refreshes it from the local database", () => {
    expect(INDEX_HTML).toContain('id="digestPanel"');
    expect(INDEX_HTML).toContain('id="digestMsg"');
    expect(APP_JS).toMatch(/api\("\/api\/digest"\)/);
    expect(APP_JS).toMatch(/paintDigestMessage\(/);
    expect(APP_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
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
    const rec = (await ctx.approvals.propose({ prNumber: 7, body: "Please fix CI", reason: "CI red", requestedBy: "web:reader", via: "web" })).record;
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

  it("GET /api/actions drops a pending request once the pull request is closed", async () => {
    const { call, github, id } = await withPending();
    github.getPrSummary.mockResolvedValue({
      number: 7,
      title: "Fix login",
      sourceUrl: "https://github.com/acme/app/pull/7",
      state: "closed",
      merged: true,
    });
    const list = await (await call("/api/actions", { key: READER })).json();
    const row = list.actions.find((a: { id: string }) => a.id === id);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/is merged/);
    expect(list.actions.filter((a: { status: string }) => a.status === "pending")).toHaveLength(0);
  });

  it("GET /api/actions still returns a pending request when later history would fill the cap", async () => {
    const { call, approvals } = await start();
    const old = (await approvals.propose({
      prNumber: 99,
      body: "Please fix CI",
      reason: "CI red",
      requestedBy: "web:reader",
      via: "web",
    })).record;
    for (let i = 0; i < 20; i += 1) {
      const a = (await approvals.propose({
        prNumber: i + 1,
        body: "Please fix CI",
        reason: "CI red",
        requestedBy: `web:u${i}`,
        via: "web",
      })).record;
      await approvals.approve(a.id, APPROVER_ACTOR);
    }
    const list = await (await call("/api/actions", { key: READER })).json();
    expect(list.actions.some((a: { id: string; status: string }) => a.id === old.id && a.status === "pending")).toBe(true);
  });
});
