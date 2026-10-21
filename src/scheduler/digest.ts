import cron from "node-cron";
import type { GitHubClient } from "../github/client.js";
import type { TriageAssessment } from "../triage/analyze.js";
import { buildQueue } from "../triage/queue.js";
import type { QueueResult } from "../triage/queue.js";

const TOP_N = 3;

const brief = (a: TriageAssessment): string => {
  const why = a.signals.find((s) => s.code === "long_wait" || s.code === "small" || s.code === "approved")?.text;
  const caveat = a.confidence === "high" ? "" : ` [confidence ${a.confidence}]`;
  return `- #${a.number} ${a.title}${caveat}${why ? ` (${why.replace(/\.$/, "")})` : ""}\n  ${a.sourceUrl}`;
};

/**
 * The morning digest. Built from the deterministic queue, not the model:
 * it costs nothing, cannot be blocked by the AI budget, and says the same thing every time
 * for the same data.
 */
export function renderDigest(q: QueueResult): string {
  const lines = [`PR digest for ${q.repo}`, `(live GitHub data, ${q.generatedAt})`, ``];
  const review = q.items.filter((a) => a.state === "needs_review");
  const merge = q.items.filter((a) => a.state === "ready_to_merge");
  const blocked = q.items.filter((a) => a.state === "waiting_on_author");
  const unclear = q.items.filter((a) => a.state === "unclear");
  const drafts = q.items.filter((a) => a.state === "draft");

  if (q.items.length === 0 && q.failed.length === 0) {
    return `PR digest for ${q.repo}\n\nNo open pull requests. Nothing to review today.`;
  }

  if (review.length > 0) {
    lines.push(`Review first (${review.length} waiting):`);
    review.slice(0, TOP_N).forEach((a) => lines.push(brief(a)));
    if (review.length > TOP_N) lines.push(`  ...and ${review.length - TOP_N} more. Send /triage queue for the full list.`);
    lines.push(``);
  } else {
    lines.push(`Nothing is waiting on a reviewer right now.`, ``);
  }
  if (merge.length > 0) {
    lines.push(`Ready to merge (approved, no blockers found):`);
    merge.forEach((a) => lines.push(brief(a)));
    lines.push(``);
  }
  if (blocked.length > 0) {
    lines.push(`Waiting on the author (do not review yet): ${blocked.map((a) => `#${a.number}`).join(", ")}`, ``);
  }
  if (unclear.length > 0) {
    lines.push(`CI status unknown, check by hand: ${unclear.map((a) => `#${a.number}`).join(", ")}`, ``);
  }
  if (drafts.length > 0) lines.push(`${drafts.length} draft(s) skipped.`, ``);
  if (q.failed.length > 0) {
    lines.push(`Could not analyse: ${q.failed.map((f) => `#${f.number}`).join(", ")} (GitHub lookup failed).`, ``);
  }
  if (q.truncated) lines.push(`More open PRs exist than were analysed.`);
  return lines.join("\n").trim();
}

export interface DigestDeps {
  github: Pick<GitHubClient, "listOpenPrs" | "getPr" | "repo">;
  /** Deliver text to the team. */
  send: (text: string) => Promise<void>;
}

/**
 * Run the digest once. A failure is reported to the team instead of being swallowed,
 * so a silent morning never means "nothing to do" when it really means "broken".
 */
export async function runDigest(deps: DigestDeps): Promise<{ ok: boolean }> {
  try {
    const q = await buildQueue(deps.github);
    await deps.send(renderDigest(q));
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("Digest failed:", reason);
    try {
      await deps.send(`The scheduled PR digest could not be built: ${reason}\nSend /triage queue to try again by hand.`);
    } catch (sendErr) {
      console.error("Digest failure notice could not be delivered:", sendErr instanceof Error ? sendErr.message : sendErr);
    }
    return { ok: false };
  }
}

export interface SchedulerHandle {
  stop(): void;
}

/** Schedule the digest. Throws on a bad cron expression so a typo fails at startup, not silently never. */
export function startDigestSchedule(expression: string, run: () => Promise<unknown>): SchedulerHandle {
  if (!cron.validate(expression)) {
    throw new Error(`DIGEST_CRON is not a valid cron expression: "${expression}"`);
  }
  const task = cron.schedule(expression, () => {
    void run().catch((err) => console.error("Scheduled run crashed:", err));
  });
  return { stop: () => void task.stop() };
}
