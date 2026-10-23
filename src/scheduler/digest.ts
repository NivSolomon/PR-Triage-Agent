import cron from "node-cron";
import type { GitHubReader } from "../github/port.js";
import type { RunRepository } from "../store/runs.js";
import type { TriageAssessment } from "../triage/analyze.js";
import { buildQueue } from "../triage/queue.js";
import type { QueueResult } from "../triage/queue.js";
import { count } from "../text/en.js";

const TOP_N = 3;

/** "Fri 23 Oct, 08:30" - the same clock the schedule uses, not a raw UTC ISO string. */
export function formatDigestClock(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    const opts: Intl.DateTimeFormatOptions = {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(timeZone ? { timeZone } : {}),
    };
    const p: Record<string, string> = {};
    new Intl.DateTimeFormat("en-GB", opts).formatToParts(d).forEach((part) => {
      if (part.type !== "literal") p[part.type] = part.value;
    });
    if (!p.weekday || !p.day || !p.month || !p.hour || !p.minute) return iso;
    return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute}`;
  } catch {
    return iso;
  }
}

const brief = (a: TriageAssessment): string => {
  const why = a.signals.find((s) => s.code === "long_wait" || s.code === "small" || s.code === "approved")?.text;
  const caveat = a.confidence === "high" ? "" : ` [confidence ${a.confidence}]`;
  const lines = [`- #${a.number} ${a.title}${caveat}`];
  if (why) lines.push(`  ${why.replace(/\.$/, "")}`);
  lines.push(`  ${a.sourceUrl}`);
  return lines.join("\n");
};

const named = (a: TriageAssessment): string => `- #${a.number} ${a.title}`;

/**
 * The morning digest. Built from the deterministic queue, not the model:
 * it costs nothing, cannot be blocked by the AI budget, and says the same thing every time
 * for the same data.
 */
export function renderDigest(q: QueueResult, opts: { timeZone?: string } = {}): string {
  const clock = formatDigestClock(q.generatedAt, opts.timeZone ?? process.env.TZ);
  const lines = [`PR digest for ${q.repo}`, `(live GitHub data, ${clock})`, ``];
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
    if (review.length > TOP_N) lines.push(`  ...and ${count(review.length - TOP_N, "more", "more")}. Send /triage queue for the full list.`);
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
    lines.push(`Waiting on the author (do not review yet):`);
    blocked.forEach((a) => lines.push(named(a)));
    lines.push(``);
  }
  if (unclear.length > 0) {
    lines.push(`CI status unknown, check by hand:`);
    unclear.forEach((a) => lines.push(named(a)));
    lines.push(``);
  }
  if (drafts.length > 0) lines.push(`${count(drafts.length, "draft")} skipped.`, ``);
  if (q.failed.length > 0) {
    lines.push(`Could not analyse: ${q.failed.map((f) => `#${f.number}`).join(", ")} (GitHub lookup failed).`, ``);
  }
  if (q.truncated) lines.push(`More open pull requests exist than were analysed.`);
  return lines.join("\n").trim();
}

/** Name under which runs of the morning digest are recorded. */
export const DIGEST_TASK = "digest";

export interface DigestDeps {
  github: GitHubReader;
  /** Deliver text to the team. */
  send: (text: string) => Promise<void>;
  /** Where each run is recorded, so the web page can show whether the schedule fired and worked. Optional. */
  runs?: Pick<RunRepository, "record">;
  /** Clock the digest header uses. Defaults to TZ / the process zone. */
  timeZone?: string;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Run the digest once. A failure is reported to the team instead of being swallowed,
 * so a silent morning never means "nothing to do" when it really means "broken".
 * Every run, good or bad, is also written to the run log (a log failure never stops the digest).
 */
export async function runDigest(deps: DigestDeps): Promise<{ ok: boolean }> {
  const startedAt = new Date().toISOString();
  const log = (ok: boolean, error: string | null, text: string): void => {
    try {
      deps.runs?.record({ task: DIGEST_TASK, startedAt, finishedAt: new Date().toISOString(), ok, error, text });
    } catch (logErr) {
      console.error("Could not record the digest run:", messageOf(logErr));
    }
  };

  let text = "";
  try {
    text = renderDigest(await buildQueue(deps.github), { timeZone: deps.timeZone ?? process.env.TZ });
    await deps.send(text);
    log(true, null, text);
    return { ok: true };
  } catch (err) {
    const reason = messageOf(err);
    console.error("Digest failed:", reason);
    const notice = `The scheduled PR digest could not be built: ${reason}\nSend /triage queue to try again by hand.`;
    let delivered = false;
    try {
      await deps.send(notice);
      delivered = true;
    } catch (sendErr) {
      console.error("Digest failure notice could not be delivered:", messageOf(sendErr));
    }
    // Keep what the team actually saw: the notice if it went out, otherwise the digest we could not deliver (or nothing).
    log(false, reason, delivered ? notice : text);
    return { ok: false };
  }
}

export interface SchedulerHandle {
  stop(): void;
  /** When the schedule fires next, or null if it never will (stopped). */
  nextRun(): Date | null;
}

/** Schedule the digest. Throws on a bad cron expression so a typo fails at startup, not silently never. */
export function startDigestSchedule(expression: string, run: () => Promise<unknown>): SchedulerHandle {
  if (!cron.validate(expression)) {
    throw new Error(`DIGEST_CRON is not a valid cron expression: "${expression}"`);
  }
  const task = cron.schedule(expression, () => {
    void run().catch((err) => console.error("Scheduled run crashed:", err));
  });
  return { stop: () => void task.stop(), nextRun: () => task.getNextRun() };
}
