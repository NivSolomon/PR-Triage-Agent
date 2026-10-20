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
