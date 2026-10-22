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
  head: z.object({ sha: z.string(), ref: z.string() }),
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
    commit_id: z.string().nullable().optional(),
  }),
);

const rawCombinedStatus = z.object({
  total_count: z.number().optional(),
  statuses: z.array(z.object({ context: z.string(), state: z.string() })).default([]),
});

/** Pages of 100 read for a list GitHub paginates (check runs, reviews). Beyond this we say "unknown" instead of guessing. */
const MAX_PAGES = 5;

const rawPrFiles = z.array(z.object({ filename: z.string(), additions: z.number(), deletions: z.number() }));

const rawRequiredFlags = z.object({
  repository: z.object({
    pullRequest: z.object({
      commits: z.object({
        nodes: z.array(
          z.object({
            commit: z.object({
              statusCheckRollup: z
                .object({
                  contexts: z.object({
                    nodes: z.array(
                      z.object({
                        name: z.string().optional(),
                        context: z.string().optional(),
                        isRequired: z.boolean().optional(),
                      }),
                    ),
                  }),
                })
                .nullable(),
            }),
          }),
        ),
      }),
    }),
  }),
});

const REQUIRED_FLAGS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        ... on CheckRun { name isRequired(pullRequestNumber: $number) }
        ... on StatusContext { context isRequired(pullRequestNumber: $number) }
      } } } } } }
    }
  }
}`;

/** Lock files and generated code inflate a diff without adding review work. */
const GENERATED_FILE = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|go\.sum|mix\.lock|pubspec\.lock|Podfile\.lock|packages\.lock\.json)$/,
  /\.lock$/,
  /\.min\.(js|css)$/,
  /\.(map|snap)$/,
  /(^|\/)(node_modules|vendor|dist|__snapshots__)\//,
  /(\.|_)generated\.|\.g\.dart$|\.pb\.go$|_pb2(_grpc)?\.py$/,
];

export function isGeneratedFile(path: string): boolean {
  return GENERATED_FILE.some((re) => re.test(path));
}

const rawIssueEvents = z.array(z.object({ event: z.string(), created_at: z.string() }));

const rawComments = z.array(
  z.object({
    user,
    created_at: z.string(),
    body: z.string().nullable().optional(),
  }),
);

const rawPostedComment = z.object({ id: z.number(), html_url: z.string() });

export interface PostedComment {
  id: number;
  url: string;
}

/**
 * True when we cannot tell whether a write reached GitHub: no HTTP response at all
 * (network error / timeout) or a 5xx. A 4xx is a definite "it did not happen".
 */
export function isAmbiguousFailure(err: unknown): boolean {
  if (!(err instanceof GitHubError)) return false;
  return err.status === undefined || err.status >= 500;
}

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

  /** Cheap lookup (one API call) when only the headline fields are needed. */
  async getPrSummary(number: number): Promise<PrSummary> {
    if (!Number.isInteger(number) || number <= 0) {
      throw new GitHubError(`Invalid pull request number: ${number}`);
    }
    return this.toSummary(rawPrListItem.parse(await this.get(`/pulls/${number}`)));
  }

  async getPr(number: number): Promise<PrDetail> {
    if (!Number.isInteger(number) || number <= 0) {
      throw new GitHubError(`Invalid pull request number: ${number}`);
    }
    const pr = rawPr.parse(await this.get(`/pulls/${number}`));
    const summary = this.toSummary(pr);

    // Independent lookups run in parallel. CI data is allowed to be unavailable (-> null,
    // reported as "unknown"); reviews and comments failing is a real error and propagates.
    const [checks, reviews, comments, readySince] = await Promise.all([
      this.getChecks(pr.head.sha, number),
      this.getReviews(number),
      this.getComments(number),
      this.getReadySince(number, pr.created_at),
    ]);
    const reviewableLines = await this.getReviewableLines(number);

    return {
      ...summary,
      body: truncate(pr.body),
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changed_files,
      reviewableLines,
      readySince,
      mergeableState: pr.mergeable_state ?? null,
      checks,
      reviews,
      recentComments: comments.recent,
      commentCount: pr.comments,
    };
  }

  // --- writes ---

  /** Post a conversation comment on a pull request. Only call this after human approval. */
  async postComment(number: number, body: string): Promise<PostedComment> {
    if (!Number.isInteger(number) || number <= 0) {
      throw new GitHubError(`Invalid pull request number: ${number}`);
    }
    const raw = rawPostedComment.parse(await this.request("POST", `/issues/${number}/comments`, { body }));
    return { id: raw.id, url: raw.html_url };
  }

  /**
   * Find a comment containing `marker` created at/after `since`.
   * Used to find out whether a write that failed without a response actually went through.
   */
  async findCommentWithMarker(
    number: number,
    marker: string,
    since: string,
  ): Promise<PostedComment | null> {
    const raw = z
      .array(rawPostedComment.extend({ body: z.string().nullable().optional() }))
      .parse(
        await this.get(
          `/issues/${number}/comments?since=${encodeURIComponent(since)}&per_page=100`,
        ),
      );
    const hit = raw.find((c) => (c.body ?? "").includes(marker));
    return hit ? { id: hit.id, url: hit.html_url } : null;
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
      headBranch: truncate(p.head.ref, 200),
      headSha: p.head.sha,
      sourceUrl: p.html_url,
    };
  }

  /**
   * CI from both check runs and legacy commit statuses (Jenkins, Travis...), plus which failures are optional.
   * Any failure to read CI gives null = "unknown", never "passing".
   */
  private async getChecks(sha: string, number: number): Promise<CheckSummary | null> {
    try {
      const [raw, combined, flags] = await Promise.all([
        this.getAllCheckRuns(sha),
        this.get(`/commits/${sha}/status?per_page=100`).then((r) => rawCombinedStatus.parse(r)),
        this.getRequiredFlags(number),
      ]);
      // A failure on a page we never read would look like a green build. If the list is incomplete, CI is unknown.
      if (combined.total_count !== undefined && combined.statuses.length < combined.total_count) {
        throw new GitHubError(`Only ${combined.statuses.length} of ${combined.total_count} commit statuses could be read`);
      }
      const failing: string[] = [];
      const pending: string[] = [];
      let passing = 0;
      for (const run of raw.check_runs) {
        if (run.status !== "completed") pending.push(run.name);
        else if (run.conclusion && FAILING.has(run.conclusion)) failing.push(run.name);
        else if (run.conclusion && PASSING.has(run.conclusion)) passing += 1;
      }
      for (const s of combined.statuses) {
        if (s.state === "failure" || s.state === "error") failing.push(s.context);
        else if (s.state === "pending") pending.push(s.context);
        else if (s.state === "success") passing += 1;
      }
      // Optional only when the repo really defines required checks. With none defined, every failure blocks.
      const anyRequired = flags ? [...flags.values()].some(Boolean) : false;
      const optionalFailing = flags && anyRequired ? failing.filter((n) => flags.get(n) === false) : [];
      return {
        total: raw.total_count + combined.statuses.length,
        passing,
        failing,
        optionalFailing,
        requiredKnown: flags !== null,
        pending,
        sourceUrl: `https://github.com/${this.options.repo}/commit/${sha}/checks`,
      };
    } catch (err) {
      if (err instanceof GitHubError) return null; // CI data unavailable: report "unknown", not "passing".
      throw err;
    }
  }

  /** Every check run for a commit. Throws when some cannot be read, so the caller reports CI as unknown. */
  private async getAllCheckRuns(sha: string): Promise<z.infer<typeof rawCheckRuns>> {
    const runs: z.infer<typeof rawCheckRuns>["check_runs"] = [];
    let totalCount = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const raw = rawCheckRuns.parse(await this.get(`/commits/${sha}/check-runs?per_page=100&page=${page}`));
      totalCount = raw.total_count;
      runs.push(...raw.check_runs);
      if (runs.length >= totalCount || raw.check_runs.length === 0) break;
    }
    if (runs.length < totalCount) {
      throw new GitHubError(`Only ${runs.length} of ${totalCount} check runs could be read`);
    }
    return { total_count: totalCount, check_runs: runs };
  }

  /** Which checks are required to merge, via GraphQL (REST would need admin rights). Null if it cannot be read. */
  private async getRequiredFlags(number: number): Promise<Map<string, boolean> | null> {
    try {
      const [owner, name] = this.options.repo.split("/");
      const data = rawRequiredFlags.parse(await this.graphql(REQUIRED_FLAGS_QUERY, { owner, name, number }));
      const nodes = data.repository.pullRequest.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
      const flags = new Map<string, boolean>();
      for (const n of nodes) {
        const key = n.name ?? n.context;
        if (key !== undefined && n.isRequired !== undefined) flags.set(key, n.isRequired);
      }
      return flags;
    } catch {
      return null;
    }
  }

  /** Changed lines a human has to read: lock files and generated code are left out. Null if unknown. */
  private async getReviewableLines(number: number): Promise<number | null> {
    try {
      let total = 0;
      for (let page = 1; page <= 3; page++) {
        const files = rawPrFiles.parse(await this.get(`/pulls/${number}/files?per_page=100&page=${page}`));
        for (const f of files) if (!isGeneratedFile(f.filename)) total += f.additions + f.deletions;
        if (files.length < 100) return total;
      }
      return null; // 300+ files: not worth guessing
    } catch {
      return null;
    }
  }
  /**
   * When the PR last became ready for review. A PR that was a draft for two weeks has not "been waiting"
   * for two weeks. No ready_for_review event means it was opened ready. Reads up to 500 events; null
   * (unknown) if they cannot be read or are too many, so the caller can say so instead of guessing.
   */
  private async getReadySince(number: number, createdAt: string): Promise<string | null> {
    try {
      const ready: string[] = [];
      for (let page = 1; page <= 5; page++) {
        const events = rawIssueEvents.parse(await this.get(`/issues/${number}/events?per_page=100&page=${page}`));
        for (const e of events) if (e.event === "ready_for_review") ready.push(e.created_at);
        if (events.length < 100) {
          ready.sort();
          return ready.length > 0 ? (ready[ready.length - 1] as string) : createdAt;
        }
      }
      return null; // 500+ events: too many to read them all, so say "unknown" instead of guessing
    } catch {
      return null;
    }
  }
  private async getReviews(number: number): Promise<ReviewSummary[]> {
    // Reviews come oldest first, so a page we never read would hold the NEWEST ones (a late "changes requested"
    // or a dismissed approval). Read every page; if there are too many, fail loudly instead of ranking on stale reviews.
    const raw: z.infer<typeof rawReviews> = [];
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) throw new GitHubError(`Pull request ${number} has more than ${MAX_PAGES * 100} reviews`);
      const batch = rawReviews.parse(await this.get(`/pulls/${number}/reviews?per_page=100&page=${page}`));
      raw.push(...batch);
      if (batch.length < 100) break;
    }
    // Keep the latest meaningful state per reviewer. Plain comments don't override an approval.
    const latest = new Map<string, ReviewSummary>();
    for (const r of raw) {
      const reviewer = r.user?.login ?? "unknown";
      if (r.state === "COMMENTED" && latest.has(reviewer)) continue;
      latest.set(reviewer, {
        reviewer,
        state: r.state,
        submittedAt: r.submitted_at ?? null,
        commitId: r.commit_id ?? null,
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

  private async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(new URL("/graphql", this.baseUrl).toString(), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          "Content-Type": "application/json",
          "User-Agent": "pr-triage-agent",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new GitHubError(`Could not reach GitHub: ${(err as Error).message}`);
    }
    if (!res.ok) throw this.toError(res);
    const body = (await res.json()) as { data?: unknown; errors?: Array<{ message?: string }> };
    if (body.errors?.length) throw new GitHubError(`GitHub GraphQL error: ${body.errors[0]?.message ?? "unknown"}`);
    return body.data;
  }

  private get(path: string): Promise<unknown> {
    return this.request("GET", path);
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}/repos/${this.options.repo}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "pr-triage-agent",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // No HTTP status: we do not know whether GitHub received the request.
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
