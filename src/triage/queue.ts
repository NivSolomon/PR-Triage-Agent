import type { GitHubReader } from "../github/port.js";
import type { PrDetail } from "../github/types.js";
import { assessPr, rankAssessments } from "./analyze.js";
import type { TriageAssessment } from "./analyze.js";

export interface QueueResult {
  generatedAt: string;
  repo: string;
  /** Ranked, best-to-review first. */
  items: TriageAssessment[];
  /** PRs we found but could not analyse (never silently dropped). */
  failed: { number: number; title: string; sourceUrl: string; error: string }[];
  /** True when more open PRs exist than the limit we analysed. */
  truncated: boolean;
}

const CONCURRENCY = 4;

// Like Promise.all(items.map(fn)) but runs at most `limit` calls at once (to respect GitHub rate limits).
// Each worker takes the next unclaimed index; results keep the input order.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Build the ranked review queue from live GitHub data. */
export async function buildQueue(
  github: GitHubReader,
  opts: { limit?: number; now?: Date } = {},
): Promise<QueueResult> {
  const limit = opts.limit ?? 15;
  const now = opts.now ?? new Date();
  // Ask for one extra so we can tell the user the list was cut off.
  const open = await github.listOpenPrs(limit + 1);
  const truncated = open.length > limit;
  const slice = open.slice(0, limit);

  const settled = await mapLimit(slice, CONCURRENCY, async (p) => {
    try {
      const detail: PrDetail = await github.getPr(p.number);
      // listOpenPrs is open-only; a PR can still close between the list and this fetch.
      if (detail.state === "closed") return { ok: true as const, assessment: null };
      return { ok: true as const, assessment: assessPr(detail, now) };
    } catch (err) {
      return {
        ok: false as const,
        failure: {
          number: p.number,
          title: p.title,
          sourceUrl: p.sourceUrl,
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  });

  // One broken PR never fails the whole queue: successes are ranked, failures are reported separately.
  const items = rankAssessments(settled.flatMap((s) => (s.ok && s.assessment ? [s.assessment] : [])));
  const failed = settled.flatMap((s) => (s.ok ? [] : [s.failure]));
  return { generatedAt: now.toISOString(), repo: github.repo, items, failed, truncated };
}
