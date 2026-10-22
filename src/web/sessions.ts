import { randomBytes } from "node:crypto";

/** Who is signed in on the web page. `actor` is what the audit trail records, e.g. "web:dana". */
export interface Principal {
  name: string;
  role: "reader" | "approver";
  actor: string;
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
  /** Upper bound on live sessions, so a flood of logins cannot grow memory without limit. */
  maxSessions?: number;
  now?: () => number;
}

/**
 * Server-side web sessions. After a person proves they hold a key once, the browser only carries a random,
 * unguessable session id in an HttpOnly cookie: the key itself is not kept in the page, so a script bug
 * cannot read it, and a session can end (logout, idle, maximum age) without changing anyone's key.
 * Sessions live in memory: a restart signs everyone out, which is an acceptable price for a single instance.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  readonly idleMs: number;
  readonly maxAgeMs: number;
  private readonly maxSessions: number;
  private readonly now: () => number;

  constructor(o: SessionOptions = {}) {
    this.idleMs = o.idleMs ?? 2 * 60 * 60_000;
    this.maxAgeMs = o.maxAgeMs ?? 12 * 60 * 60_000;
    this.maxSessions = o.maxSessions ?? 500;
    this.now = o.now ?? Date.now;
  }

  create(principal: Principal): string {
    this.prune();
    // Past the cap, the oldest sessions go first.
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const id = randomBytes(32).toString("base64url");
    const now = this.now();
    this.sessions.set(id, { principal, createdAt: now, lastSeen: now });
    return id;
  }

  get(id: string): Principal | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const now = this.now();
    if (now - s.createdAt > this.maxAgeMs || now - s.lastSeen > this.idleMs) {
      this.sessions.delete(id);
      return null;
    }
    s.lastSeen = now;
    return s.principal;
  }

  destroy(id: string): void {
    this.sessions.delete(id);
  }

  get size(): number {
    return this.sessions.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, s] of this.sessions) {
      if (now - s.createdAt > this.maxAgeMs || now - s.lastSeen > this.idleMs) this.sessions.delete(id);
    }
  }
}
