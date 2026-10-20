import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Ordered, append-only migrations. Never edit an applied one; add a new entry. */
const MIGRATIONS: string[] = [
  `CREATE TABLE pending_actions (
     id            TEXT PRIMARY KEY,
     kind          TEXT NOT NULL,
     pr_number     INTEGER NOT NULL,
     pr_title      TEXT NOT NULL,
     pr_url        TEXT NOT NULL,
     body          TEXT NOT NULL,
     status        TEXT NOT NULL,
     requested_by  TEXT NOT NULL,
     requested_via TEXT NOT NULL,
     reason        TEXT NOT NULL DEFAULT '',
     created_at    TEXT NOT NULL,
     expires_at    TEXT NOT NULL,
     decided_by    TEXT,
     decided_at    TEXT,
     result_url    TEXT,
     error         TEXT
   );
   CREATE INDEX idx_actions_status ON pending_actions(status);`,
  // One row per model call. request_id groups the calls of one user request.
  `CREATE TABLE llm_usage (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     ts            TEXT NOT NULL,
     month         TEXT NOT NULL,
     day           TEXT NOT NULL,
     actor         TEXT NOT NULL,
     request_id    TEXT NOT NULL,
     purpose       TEXT NOT NULL,
     model         TEXT NOT NULL,
     input_tokens  INTEGER NOT NULL,
     output_tokens INTEGER NOT NULL,
     cost_usd      REAL NOT NULL
   );
   CREATE INDEX idx_usage_month ON llm_usage(month);
   CREATE INDEX idx_usage_day_actor ON llm_usage(day, actor);
   CREATE TABLE kv (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
];

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v += 1) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v] as string);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
