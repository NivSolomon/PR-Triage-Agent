import { describe, expect, it } from "vitest";
import { GitHubClient, GitHubError, isAmbiguousFailure, truncate } from "../src/github/client.js";

type Route = unknown | { status: number; headers?: Record<string, string> };

/** Build a fake fetch that serves canned JSON by URL substring. */
function fakeFetch(routes: Record<string, Route>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("not routed: " + url, { status: 500 });
    const route = routes[key] as { status?: number; headers?: Record<string, string> };
    if (route && typeof route === "object" && "status" in route && route.status !== undefined) {
      return new Response("{}", { status: route.status, headers: route.headers });
    }
    return new Response(JSON.stringify(route), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const pr = (over: Record<string, unknown> = {}) => ({
  number: 7,
  title: "Fix login",
  user: { login: "dana" },
  draft: false,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-02T10:00:00Z",
  html_url: "https://github.com/acme/app/pull/7",
  labels: [{ name: "bug" }],
  requested_reviewers: [{ login: "lee" }],
  base: { ref: "main" },
  head: { sha: "abc123" },
  ...over,
});

const client = (routes: Record<string, Route>) =>
  new GitHubClient({ token: "t", repo: "acme/app", fetchImpl: fakeFetch(routes) });

describe("listOpenPrs", () => {
  it("normalises pull requests and keeps the source url", async () => {
    const prs = await client({ "/pulls?state=open": [pr()] }).listOpenPrs();
    expect(prs).toEqual([
      expect.objectContaining({
        number: 7,
        author: "dana",
        labels: ["bug"],
        requestedReviewers: ["lee"],
        sourceUrl: "https://github.com/acme/app/pull/7",
      }),
    ]);
  });

  it("tolerates a deleted author (null user)", async () => {
    const prs = await client({ "/pulls?state=open": [pr({ user: null })] }).listOpenPrs();
    expect(prs[0]?.author).toBe("unknown");
  });
});

describe("getPr", () => {
  const base = {
    "/pulls/7/reviews": [
      { user: { login: "lee" }, state: "APPROVED", submitted_at: "2026-10-02T09:00:00Z" },
      { user: { login: "lee" }, state: "COMMENTED", submitted_at: "2026-10-02T09:30:00Z" },
      { user: { login: "sam" }, state: "CHANGES_REQUESTED", submitted_at: "2026-10-02T11:00:00Z" },
    ],
    "/issues/7/comments": [
      { user: { login: "dana" }, created_at: "2026-10-02T12:00:00Z", body: "Pushed a fix" },
    ],
    "/pulls/7": pr({
      body: "Closes #3",
      additions: 40,
      deletions: 5,
      changed_files: 3,
      mergeable_state: "blocked",
      comments: 1,
    }),
  };

  it("summarises CI into passing / failing / pending", async () => {
    const detail = await client({
      ...base,
      "/check-runs": {
        total_count: 4,
        check_runs: [
          { name: "lint", status: "completed", conclusion: "success" },
          { name: "unit", status: "completed", conclusion: "failure" },
          { name: "e2e", status: "in_progress", conclusion: null },
          { name: "docs", status: "completed", conclusion: "skipped" },
        ],
      },
    }).getPr(7);

    expect(detail.checks).toMatchObject({
      total: 4,
      passing: 2,
      failing: ["unit"],
      pending: ["e2e"],
    });
    expect(detail.additions).toBe(40);
    expect(detail.mergeableState).toBe("blocked");
  });

  it("keeps the latest meaningful review per reviewer (a comment does not erase an approval)", async () => {
    const detail = await client({
      ...base,
      "/check-runs": { total_count: 0, check_runs: [] },
    }).getPr(7);
    const states = Object.fromEntries(detail.reviews.map((r) => [r.reviewer, r.state]));
    expect(states).toEqual({ lee: "APPROVED", sam: "CHANGES_REQUESTED" });
  });

  it("reports CI as unknown (null), not passing, when the checks API is unavailable", async () => {
    const detail = await client({ ...base, "/check-runs": { status: 403 } }).getPr(7);
    expect(detail.checks).toBeNull();
  });

  it("truncates long untrusted text", async () => {
    const long = "x".repeat(5000);
    const detail = await client({
      ...base,
      "/pulls/7": pr({ body: long }),
      "/check-runs": { total_count: 0, check_runs: [] },
    }).getPr(7);
    expect(detail.body.length).toBeLessThan(700);
    expect(detail.body.endsWith("[truncated]")).toBe(true);
  });

  it("rejects an invalid pull request number before calling GitHub", async () => {
    await expect(client({}).getPr(-1)).rejects.toThrow(GitHubError);
  });
});

describe("error handling", () => {
  it("explains a 404 clearly", async () => {
    await expect(client({ "/pulls/9": { status: 404 } }).getPr(9)).rejects.toThrow(/Not found/);
  });

  it("distinguishes rate limiting from a permission problem", async () => {
    await expect(
      client({
        "/pulls?state=open": { status: 403, headers: { "x-ratelimit-remaining": "0" } },
      }).listOpenPrs(),
    ).rejects.toThrow(/rate limit/);
    await expect(client({ "/pulls?state=open": { status: 403 } }).listOpenPrs()).rejects.toThrow(
      /permission/,
    );
  });

  it("wraps network failures", async () => {
    const failing = new GitHubClient({
      token: "t",
      repo: "acme/app",
      fetchImpl: (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    await expect(failing.listOpenPrs()).rejects.toThrow(/Could not reach GitHub/);
  });
});

describe("truncate", () => {
  it("handles null and short strings", () => {
    expect(truncate(null)).toBe("");
    expect(truncate("  hi  ")).toBe("hi");
  });
});

describe("writes", () => {
  it("postComment sends the body as JSON and returns the comment url", async () => {
    let captured: { method?: string; body?: string } = {};
    const c = new GitHubClient({
      token: "t",
      repo: "acme/app",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        captured = { method: init.method, body: String(init.body) };
        return new Response(JSON.stringify({ id: 5, html_url: "https://x/c5" }), { status: 201 });
      }) as unknown as typeof fetch,
    });
    const res = await c.postComment(7, "hello");
    expect(res).toEqual({ id: 5, url: "https://x/c5" });
    expect(captured.method).toBe("POST");
    expect(JSON.parse(captured.body ?? "{}")).toEqual({ body: "hello" });
  });

  it("findCommentWithMarker returns the matching comment or null", async () => {
    const comments = [
      { id: 1, html_url: "https://x/c1", body: "unrelated" },
      { id: 2, html_url: "https://x/c2", body: "text <!-- pr-triage-agent:abc -->" },
    ];
    const c = client({ "/issues/7/comments": comments });
    expect(await c.findCommentWithMarker(7, "<!-- pr-triage-agent:abc -->", "2026-10-01T00:00:00Z")).toEqual({
      id: 2,
      url: "https://x/c2",
    });
    expect(await c.findCommentWithMarker(7, "<!-- pr-triage-agent:zzz -->", "2026-10-01T00:00:00Z")).toBeNull();
  });

  it("getPrSummary makes a single lightweight lookup", async () => {
    const s = await client({ "/pulls/7": pr() }).getPrSummary(7);
    expect(s.title).toBe("Fix login");
  });

  it("classifies ambiguous failures (no response / 5xx) separately from definite ones (4xx)", () => {
    expect(isAmbiguousFailure(new GitHubError("net"))).toBe(true);
    expect(isAmbiguousFailure(new GitHubError("bad gateway", 502))).toBe(true);
    expect(isAmbiguousFailure(new GitHubError("forbidden", 403))).toBe(false);
    expect(isAmbiguousFailure(new Error("other"))).toBe(false);
  });
});
