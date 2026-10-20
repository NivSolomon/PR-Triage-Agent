import { z } from "zod";
import type {
  CheckSummary,
  CommentSummary,
  PrDetail,
  PrSummary,
  ReviewSummary,
} from "./types.js";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface GitHubClientOptions {
  token: string;
  /** "owner/repo" */
  repo: string;
  /** Injectable for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

const MAX_TEXT = 600;
const MAX_COMMENTS = 8;
const MAX_LIST = 50;

export function truncate(text: string | null | undefined, max = MAX_TEXT): string {
  const t = (text ?? "").replace(/\r\n/g, "\n").trim();
  return t.length > max ? `${t.slice(0, max)}… [truncated]` : t;
}

// --- Raw API schemas: deliberately lenient. Missing/odd fields must not crash the agent. ---

const user = z.object({ login: z.string() }).nullable().optional();

const rawPrListItem = z.object({
  number: z.number(),
  title: z.string().default(""),
  user,
  draft: z.boolean().optional().default(false),
  created_at: z.string(),
  updated_at: z.string(),
  html_url: z.string(),
  labels: z.array(z.object({ name: z.string() })).default([]),
  requested_reviewers: z.array(z.object({ login: z.string() })).default([]),
  base: z.object({ ref: z.string() }),
  head: z.object({ sha: z.string() }),
});

const rawPr = rawPrListItem.extend({
  body: z.string().nullable().optional(),
  additions: z.number().default(0),
  deletions: z.number().default(0),
  changed_files: z.number().default(0),
  mergeable_state: z.string().nullable().optional(),
  comments: z.number().default(0),
});

const rawCheckRuns = z.object({
  total_count: z.number(),
  check_runs: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable().optional(),
    }),
  ),
});

const rawReviews = z.array(
  z.object({
    user,
    state: z.string(),
    submitted_at: z.string().nullable().optional(),
  }),
);

const rawComments = z.array(
  z.object({
    user,
    created_at: z.string(),
    body: z.string().nullable().optional(),
  }),
);

const FAILING = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
const PASSING = new Set(["success", "neutral", "skipped"]);

export class GitHubClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: GitHubClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://api.github.com";
  }

  get repo(): string {
    return this.options.repo;
  }

  async listOpenPrs(limit = 30): Promise<PrSummary[]> {
    const perPage = Math.min(Math.max(limit, 1), MAX_LIST);
    const raw = await this.get(`/pulls?state=open&sort=updated&direction=desc&per_page=${perPage}`);
    return z.array(rawPrListItem).parse(raw).map((p) => this.toSummary(p));
  }

  async getPr(number: number): Promise<PrDetail> {
    if (!Number.isInteger(number) || number <= 0) {
      throw new GitHubError(`Invalid pull request number: ${number}`);
    }
    const pr = rawPr.parse(await this.get(`/pulls/${number}`));
    const summary = this.toSummary(pr);

    // Independent lookups run in parallel. CI data is allowed to be unavailable (-> null,
    // reported as "unknown"); reviews and comments failing is a real error and propagates.
    const [checks, reviews, comments] = await Promise.all([
      this.getChecks(pr.head.sha),
      this.getReviews(number),
      this.getComments(number),
    ]);

    return {
      ...summary,
      body: truncate(pr.body),
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      mergeableState: pr.mergeable_state ?? null,
      checks,
      reviews,
      recentComments: comments.recent,
      commentCount: pr.comments,
    };
  }

  // --- helpers ---

  private toSummary(p: z.infer<typeof rawPrListItem>): PrSummary {
    return {
      number: p.number,
      title: truncate(p.title, 200),
      author: p.user?.login ?? "unknown",
      draft: p.draft,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      labels: p.labels.map((l) => l.name),
      requestedReviewers: p.requested_reviewers.map((r) => r.login),
      baseBranch: p.base.ref,
      headSha: p.head.sha,
      sourceUrl: p.html_url,
    };
  }

  private async getChecks(sha: string): Promise<CheckSummary | null> {
    try {
      const raw = rawCheckRuns.parse(await this.get(`/commits/${sha}/check-runs?per_page=100`));
      const failing: string[] = [];
      const pending: string[] = [];
      let passing = 0;
      for (const run of raw.check_runs) {
        if (run.status !== "completed") pending.push(run.name);
        else if (run.conclusion && FAILING.has(run.conclusion)) failing.push(run.name);
        else if (run.conclusion && PASSING.has(run.conclusion)) passing += 1;
      }
      return {
        total: raw.total_count,
        passing,
        failing,
        pending,
        sourceUrl: `https://github.com/${this.options.repo}/commit/${sha}/checks`,
      };
    } catch (err) {
      if (err instanceof GitHubError) return null; // CI data unavailable: report "unknown", not "passing".
      throw err;
    }
  }

  private async getReviews(number: number): Promise<ReviewSummary[]> {
    const raw = rawReviews.parse(await this.get(`/pulls/${number}/reviews?per_page=100`));
    // Keep the latest meaningful state per reviewer. Plain comments don't override an approval.
    const latest = new Map<string, ReviewSummary>();
    for (const r of raw) {
      const reviewer = r.user?.login ?? "unknown";
      if (r.state === "COMMENTED" && latest.has(reviewer)) continue;
      latest.set(reviewer, {
        reviewer,
        state: r.state,
        submittedAt: r.submitted_at ?? null,
      });
    }
    return [...latest.values()];
  }

  private async getComments(number: number): Promise<{ recent: CommentSummary[] }> {
    const raw = rawComments.parse(await this.get(`/issues/${number}/comments?per_page=100`));
    const recent = raw.slice(-MAX_COMMENTS).map((c) => ({
      author: c.user?.login ?? "unknown",
      createdAt: c.created_at,
      body: truncate(c.body, 400),
    }));
    return { recent };
  }

  private async get(path: string): Promise<unknown> {
    const url = `${this.baseUrl}/repos/${this.options.repo}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "pr-triage-agent",
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new GitHubError(`Could not reach GitHub: ${(err as Error).message}`);
    }
    if (!res.ok) throw this.toError(res);
    return res.json();
  }

  private toError(res: Response): GitHubError {
    if (res.status === 404) {
      return new GitHubError(
        `Not found on GitHub (${this.options.repo}). Check the repo name, the PR number and the token's access.`,
        404,
      );
    }
    if (res.status === 401) return new GitHubError("GitHub rejected the token (401).", 401);
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      const msg =
        remaining === "0"
          ? "GitHub rate limit reached. Try again later."
          : "GitHub refused the request (403). The token may lack permission.";
      return new GitHubError(msg, res.status);
    }
    return new GitHubError(`GitHub returned HTTP ${res.status}.`, res.status);
  }
}
