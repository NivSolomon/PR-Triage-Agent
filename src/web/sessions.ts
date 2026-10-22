import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/** Who is signed in on the web page. `actor` is what the audit trail records, e.g. "web:dana". */
export interface Principal {
  name: string;
  role: "reader" | "approver";
  actor: string;
  /** GitHub login, when WEB_USERS listed one, so the queue can group "waiting for your review". */
  githubLogin?: string;
}

interface Session {
  principal: Principal;
  createdAt: number;
  lastSeen: number;
}

export interface SessionOptions {
  /** Signed out after this long without a request. */
  idleMs?: number;
  /** Signed out after this long no matter what. */
  maxAgeMs?: number;
  /** Upper bound on live sessions, so a flood of logins cannot grow without limit. */
  maxSessions?: number;
  now?: () => number;
  /** When set, sessions survive a restart (same SQLite file as the rest of the app). */
  db?: DatabaseSync;
}

/**
 * Server-side web sessions. After a person proves they hold a key once, the browser only carries a random,
 * unguessable session id in an HttpOnly cookie: the key itself is not kept in the page, so a script bug
 * cannot read it, and a session can end (logout, idle, maximum age) without changing anyone's key.
 * When a database is provided, sessions live on disk so a deploy does not sign everyone out; otherwise
 * they live in memory (tests, and a host with no database wired in).
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  readonly idleMs: number;
  readonly maxAgeMs: number;
  private readonly maxSessions: number;
  private readonly now: () => number;
  private readonly db?: DatabaseSync;

  constructor(o: SessionOptions = {}) {
    this.idleMs = o.idleMs ?? 2 * 60 * 60_000;
    this.maxAgeMs = o.maxAgeMs ?? 12 * 60 * 60_000;
    this.maxSessions = o.maxSessions ?? 500;
    this.now = o.now ?? Date.now;
    this.db = o.db;
  }

  create(principal: Principal): string {
    this.prune();
    while (this.size >= this.maxSessions) {
      const oldest = this.oldestId();
      if (oldest === undefined) break;
      this.destroy(oldest);
    }
    const id = randomBytes(32).toString("base64url");
    const now = this.now();
    if (this.db) {
      this.db
        .prepare("INSERT INTO web_sessions (id, principal_json, created_at, last_seen) VALUES (?, ?, ?, ?)")
        .run(id, JSON.stringify(principal), now, now);
    } else {
      this.sessions.set(id, { principal, createdAt: now, lastSeen: now });
    }
    return id;
  }

  get(id: string): Principal | null {
    const row = this.read(id);
    if (!row) return null;
    const now = this.now();
    if (now - row.createdAt > this.maxAgeMs || now - row.lastSeen > this.idleMs) {
      this.destroy(id);
      return null;
    }
    this.touch(id, now);
    return row.principal;
  }

  destroy(id: string): void {
    if (this.db) this.db.prepare("DELETE FROM web_sessions WHERE id = ?").run(id);
    else this.sessions.delete(id);
  }

  get size(): number {
    if (!this.db) return this.sessions.size;
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM web_sessions").get() as { n: number };
    return row.n;
  }

  private read(id: string): Session | null {
    if (!this.db) return this.sessions.get(id) ?? null;
    const row = this.db
      .prepare("SELECT principal_json, created_at, last_seen FROM web_sessions WHERE id = ?")
      .get(id) as { principal_json: string; created_at: number; last_seen: number } | undefined;
    if (!row) return null;
    try {
      return { principal: JSON.parse(row.principal_json) as Principal, createdAt: row.created_at, lastSeen: row.last_seen };
    } catch {
      this.destroy(id);
      return null;
    }
  }

  private touch(id: string, now: number): void {
    if (this.db) this.db.prepare("UPDATE web_sessions SET last_seen = ? WHERE id = ?").run(now, id);
    else {
      const s = this.sessions.get(id);
      if (s) s.lastSeen = now;
    }
  }

  private oldestId(): string | undefined {
    if (!this.db) return this.sessions.keys().next().value;
    const row = this.db.prepare("SELECT id FROM web_sessions ORDER BY created_at ASC LIMIT 1").get() as { id: string } | undefined;
    return row?.id;
  }

  private prune(): void {
    const now = this.now();
    if (!this.db) {
      for (const [id, s] of this.sessions) {
        if (now - s.createdAt > this.maxAgeMs || now - s.lastSeen > this.idleMs) this.sessions.delete(id);
      }
      return;
    }
    this.db
      .prepare("DELETE FROM web_sessions WHERE created_at < ? OR last_seen < ?")
      .run(now - this.maxAgeMs, now - this.idleMs);
  }
}
