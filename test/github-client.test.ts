import { describe, expect, it } from "vitest";
import { GitHubClient, GitHubError, isAmbiguousFailure, isGeneratedFile, truncate } from "../src/github/client.js";

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
  head: { sha: "abc123", ref: "fix/login" },
  ...over,
});

const client = (routes: Record<string, Route>) =>
  new GitHubClient({ token: "t", repo: "acme/app", fetchImpl: fakeFetch(routes), sleep: async () => undefined });

describe("listOpenPrs", () => {
  it("normalises pull requests and keeps the source url", async () => {
    const prs = await client({ "/pulls?state=open": [pr()] }).listOpenPrs();
    expect(prs).toEqual([
      expect.objectContaining({
        number: 7,
        author: "dana",
        labels: ["bug"],
        requestedReviewers: ["lee"],
        baseBranch: "main",
        headBranch: "fix/login",
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
    "/pulls/7/files": [],
    "/status": { statuses: [] },
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

  it("records which commit each review was made on, so stale approvals can be detected", async () => {
    const detail = await client({
      ...base,
      "/pulls/7/reviews": [
        { user: { login: "lee" }, state: "APPROVED", submitted_at: "2026-10-02T09:00:00Z", commit_id: "oldsha" },
        { user: { login: "sam" }, state: "APPROVED", submitted_at: "2026-10-02T09:00:00Z" },
      ],
      "/check-runs": { total_count: 0, check_runs: [] },
    }).getPr(7);
    expect(detail.reviews).toEqual([
      expect.objectContaining({ reviewer: "lee", commitId: "oldsha" }),
      expect.objectContaining({ reviewer: "sam", commitId: null }),
    ]);
  });

  describe("readySince (when the PR became ready for review)", () => {
    const withEvents = (events: Route) => client({ ...base, "/issues/7/events": events, "/check-runs": { total_count: 0, check_runs: [] } });

    it("uses the latest ready_for_review event, because a PR can start as a draft", async () => {
      const detail = await withEvents([
        { event: "labeled", created_at: "2026-10-02T08:00:00Z" },
        { event: "ready_for_review", created_at: "2026-10-05T08:00:00Z" },
        { event: "convert_to_draft", created_at: "2026-10-06T08:00:00Z" },
        { event: "ready_for_review", created_at: "2026-10-09T08:00:00Z" },
      ]).getPr(7);
      expect(detail.readySince).toBe("2026-10-09T08:00:00Z");
    });

    it("is the creation time when it was never a draft", async () => {
      const detail = await withEvents([{ event: "labeled", created_at: "2026-10-02T08:00:00Z" }]).getPr(7);
      expect(detail.readySince).toBe("2026-10-01T10:00:00Z");
    });

    it("is unknown (null), not guessed, when the events cannot be read", async () => {
      expect((await withEvents({ status: 403 }).getPr(7)).readySince).toBeNull();
    });

    it("reads past the first page of events", async () => {
      const filler = Array.from({ length: 100 }, () => ({ event: "labeled", created_at: "2026-10-02T08:00:00Z" }));
      const detail = await client({
        ...base,
        "/issues/7/events?per_page=100&page=2": [{ event: "ready_for_review", created_at: "2026-10-08T08:00:00Z" }],
        "/issues/7/events": filler,
        "/check-runs": { total_count: 0, check_runs: [] },
      }).getPr(7);
      expect(detail.readySince).toBe("2026-10-08T08:00:00Z");
    });

    it("is unknown when there are too many events to see them all", async () => {
      const many = Array.from({ length: 100 }, () => ({ event: "labeled", created_at: "2026-10-02T08:00:00Z" }));
      expect((await withEvents(many).getPr(7)).readySince).toBeNull();
    });
  });

  describe("CI: statuses and required checks", () => {
    const runs = {
      total_count: 3,
      check_runs: [
        { name: "build", status: "completed", conclusion: "success" },
        { name: "lint", status: "completed", conclusion: "failure" },
        { name: "e2e", status: "completed", conclusion: "failure" },
      ],
    };
    const flags = (entries: Array<[string, boolean]>) => ({
      data: {
        repository: {
          pullRequest: {
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      contexts: { nodes: entries.map(([name, isRequired]) => ({ name, isRequired })) },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    });

    it("marks a failing check optional only when GitHub says it is not required", async () => {
      const detail = await client({
        ...base,
        "/graphql": flags([["build", true], ["lint", false], ["e2e", true]]),
        "/check-runs": runs,
      }).getPr(7);
      expect(detail.checks).toMatchObject({ failing: ["lint", "e2e"], optionalFailing: ["lint"], requiredKnown: true });
    });

    it("treats every failure as blocking when the repo defines no required checks", async () => {
      const detail = await client({
        ...base,
        "/graphql": flags([["build", false], ["lint", false], ["e2e", false]]),
        "/check-runs": runs,
      }).getPr(7);
      expect(detail.checks).toMatchObject({ optionalFailing: [], requiredKnown: true });
    });

    it("falls back to blocking (and says it does not know) when required flags cannot be read", async () => {
      const detail = await client({ ...base, "/graphql": { status: 403 }, "/check-runs": runs }).getPr(7);
      expect(detail.checks).toMatchObject({ optionalFailing: [], requiredKnown: false });
    });

    it("also reads legacy commit statuses, which check-runs do not include", async () => {
      const detail = await client({
        ...base,
        "/status": {
          statuses: [
            { context: "ci/jenkins", state: "failure" },
            { context: "ci/travis", state: "pending" },
            { context: "ci/lint", state: "success" },
          ],
        },
        "/check-runs": { total_count: 0, check_runs: [] },
      }).getPr(7);
      expect(detail.checks).toMatchObject({ total: 3, passing: 1, failing: ["ci/jenkins"], pending: ["ci/travis"] });
    });
  });

  describe("reviewableLines (size without lock and generated files)", () => {
    const withFiles = (files: Route) =>
      client({ ...base, "/pulls/7/files": files, "/check-runs": { total_count: 0, check_runs: [] } });

    it("leaves lock files and generated code out", async () => {
      const detail = await withFiles([
        { filename: "src/app.ts", additions: 30, deletions: 5 },
        { filename: "package-lock.json", additions: 4000, deletions: 900 },
        { filename: "dist/bundle.min.js", additions: 800, deletions: 0 },
      ]).getPr(7);
      expect(detail.reviewableLines).toBe(35);
    });

    it("is unknown (null) when the file list cannot be read", async () => {
      expect((await withFiles({ status: 403 }).getPr(7)).reviewableLines).toBeNull();
    });

    it("is unknown when there are too many files to count", async () => {
      const many = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts`, additions: 1, deletions: 0 }));
      expect((await withFiles(many).getPr(7)).reviewableLines).toBeNull();
    });
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

  it("retries a GET once after a rate-limit response, and never retries a comment POST", async () => {
    let gets = 0;
    const retried = new GitHubClient({
      token: "t",
      repo: "acme/app",
      sleep: async () => undefined,
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/pulls?state=open")) {
          gets += 1;
          if (gets === 1) return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
          return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.includes("/comments")) {
          return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
        }
        return new Response("not routed", { status: 500 });
      }) as typeof fetch,
    });
    await expect(retried.listOpenPrs()).resolves.toEqual([]);
    expect(gets).toBe(2);
    await expect(retried.postComment(7, "hi")).rejects.toThrow(/rate limit|HTTP 429/);
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

describe("isGeneratedFile", () => {
  it.each([
    "package-lock.json",
    "web/yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.lock",
    "go.sum",
    "public/app.min.js",
    "src/__snapshots__/a.test.ts.snap",
    "dist/index.js",
    "api/user.pb.go",
    "src/schema.generated.ts",
  ])("%s is generated", (f) => expect(isGeneratedFile(f)).toBe(true));

  it.each(["src/app.ts", "README.md", "src/distance.ts", "lockfile-parser.ts", "docs/vendor-guide.md"])(
    "%s is real code",
    (f) => expect(isGeneratedFile(f)).toBe(false),
  );
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
    expect(s.state).toBe("open");
    expect(s.locked).toBe(false);
  });

  it("getPrSummary reports a closed or locked pull request", async () => {
    const closed = await client({ "/pulls/7": pr({ state: "closed", locked: true }) }).getPrSummary(7);
    expect(closed.state).toBe("closed");
    expect(closed.locked).toBe(true);
  });

  it("classifies ambiguous failures (no response / 5xx) separately from definite ones (4xx)", () => {
    expect(isAmbiguousFailure(new GitHubError("net"))).toBe(true);
    expect(isAmbiguousFailure(new GitHubError("bad gateway", 502))).toBe(true);
    expect(isAmbiguousFailure(new GitHubError("forbidden", 403))).toBe(false);
    expect(isAmbiguousFailure(new Error("other"))).toBe(false);
  });
});

describe("getPr: lists GitHub splits into pages", () => {
  const rest = {
    "/issues/7/comments": [],
    "/pulls/7/files": [],
    "/issues/7/events": [],
    "/pulls/7": pr({ additions: 1, deletions: 1, changed_files: 1, mergeable_state: "clean", comments: 0 }),
  };
  const run = (name: string, conclusion = "success") => ({ name, status: "completed", conclusion });
  const many = (n: number, make: (i: number) => unknown) => Array.from({ length: n }, (_, i) => make(i));
  const runsUrl = (page: number) => `/commits/abc123/check-runs?per_page=100&page=${page}`;

  it("reads every page of check runs, so a failure on page 2 is not mistaken for a green build", async () => {
    const detail = await client({
      [runsUrl(1)]: { total_count: 150, check_runs: many(100, (i) => run(`job-${i}`)) },
      [runsUrl(2)]: { total_count: 150, check_runs: [...many(49, (i) => run(`late-${i}`)), run("late-fail", "failure")] },
      "/commits/abc123/status": { statuses: [] },
      "/pulls/7/reviews": [],
      ...rest,
    }).getPr(7);
    expect(detail.checks).toMatchObject({ total: 150, passing: 149, failing: ["late-fail"] });
  });

  it("reports CI as unknown when not every check run could be read", async () => {
    const detail = await client({
      [runsUrl(1)]: { total_count: 150, check_runs: many(100, (i) => run(`job-${i}`)) },
      [runsUrl(2)]: { total_count: 150, check_runs: [] },
      "/commits/abc123/status": { statuses: [] },
      "/pulls/7/reviews": [],
      ...rest,
    }).getPr(7);
    expect(detail.checks).toBeNull();
  });

  it("reports CI as unknown when not every commit status could be read", async () => {
    const detail = await client({
      "/check-runs": { total_count: 0, check_runs: [] },
      "/commits/abc123/status": { total_count: 40, statuses: many(30, (i) => ({ context: `ci-${i}`, state: "success" })) },
      "/pulls/7/reviews": [],
      ...rest,
    }).getPr(7);
    expect(detail.checks).toBeNull();
  });

  it("reads every page of reviews: a late change request on page 2 replaces an earlier approval", async () => {
    const detail = await client({
      "/pulls/7/reviews?per_page=100&page=1": many(100, (i) => ({ user: { login: `u${i}` }, state: "APPROVED", commit_id: "abc123" })),
      "/pulls/7/reviews?per_page=100&page=2": [
        { user: { login: "u0" }, state: "CHANGES_REQUESTED", commit_id: "abc123" },
        { user: { login: "late" }, state: "CHANGES_REQUESTED", commit_id: "abc123" },
      ],
      "/check-runs": { total_count: 0, check_runs: [] },
      "/commits/abc123/status": { statuses: [] },
      ...rest,
    }).getPr(7);
    const states = new Map(detail.reviews.map((r) => [r.reviewer, r.state]));
    expect(states.get("u0")).toBe("CHANGES_REQUESTED");
    expect(states.get("late")).toBe("CHANGES_REQUESTED");
    expect(states.get("u1")).toBe("APPROVED");
    expect(detail.reviews).toHaveLength(101);
  });

  it("reads the newest conversation comments, not the first 100 oldest", async () => {
    const oldest = many(100, (i) => ({
      user: { login: "old" },
      created_at: "2026-10-01T00:00:00Z",
      body: `old-${i}`,
    }));
    const newest = many(5, (i) => ({
      user: { login: "new" },
      created_at: "2026-10-20T00:00:00Z",
      body: `new-${i}`,
    }));
    const detail = await client({
      "/issues/7/comments?per_page=100&page=2": newest,
      "/issues/7/comments": oldest,
      "/pulls/7/reviews": [],
      "/pulls/7/files": [],
      "/issues/7/events": [],
      "/check-runs": { total_count: 0, check_runs: [] },
      "/commits/abc123/status": { statuses: [] },
      "/pulls/7": pr({ additions: 1, deletions: 1, changed_files: 1, mergeable_state: "clean", comments: 105 }),
    }).getPr(7);
    expect(detail.recentComments.map((c) => c.body)).toEqual([
      "old-97",
      "old-98",
      "old-99",
      "new-0",
      "new-1",
      "new-2",
      "new-3",
      "new-4",
    ]);
    expect(detail.recentComments[0]?.body).not.toBe("old-0");
  });

  it("fails loudly, instead of ranking on stale reviews, when there are more reviews than it will read", async () => {
    await expect(
      client({
        "/pulls/7/reviews": many(100, (i) => ({ user: { login: `u${i}` }, state: "APPROVED" })),
        "/check-runs": { total_count: 0, check_runs: [] },
        "/commits/abc123/status": { statuses: [] },
        ...rest,
      }).getPr(7),
    ).rejects.toThrow(GitHubError);
  });
});
