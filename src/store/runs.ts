import type { DatabaseSync } from "node:sqlite";

/** One run of a scheduled task. `ok` means the digest was built AND delivered. */
export interface RunRecord {
  id: number;
  task: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  /** Why it failed (build or delivery). Null when ok. */
  error: string | null;
  /** What was sent to the team (on failure: the failure notice, or empty if nothing could be sent). */
  text: string;
}

interface Row {
  id: number;
  task: string;
  started_at: string;
  finished_at: string;
  ok: number;
  error: string | null;
  text: string;
}

/** Only the newest runs are useful; a weekday task would otherwise grow the table forever. */
const KEEP_PER_TASK = 60;

const toRecord = (r: Row): RunRecord => ({
  id: r.id,
  task: r.task,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  ok: r.ok === 1,
  error: r.error,
  text: r.text,
});

/** History of scheduled runs, so "did the 08:30 job run?" has an answer that survives a restart. */
export class RunRepository {
  constructor(private readonly db: DatabaseSync) {}

  record(run: Omit<RunRecord, "id">): void {
    this.db
      .prepare("INSERT INTO scheduler_runs (task, started_at, finished_at, ok, error, text) VALUES (?, ?, ?, ?, ?, ?)")
      .run(run.task, run.startedAt, run.finishedAt, run.ok ? 1 : 0, run.error, run.text);
    this.db
      .prepare(
        "DELETE FROM scheduler_runs WHERE task = ? AND id NOT IN (SELECT id FROM scheduler_runs WHERE task = ? ORDER BY id DESC LIMIT ?)",
      )
      .run(run.task, run.task, KEEP_PER_TASK);
  }

  /** Newest first. */
  recent(task: string, limit = 10): RunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM scheduler_runs WHERE task = ? ORDER BY id DESC LIMIT ?")
      .all(task, limit) as unknown as Row[];
    return rows.map(toRecord);
  }
}
