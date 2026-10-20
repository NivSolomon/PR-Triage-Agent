import { createHash, timingSafeEqual } from "node:crypto";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time comparison: hashing first makes both sides the same length. */
export function sameSecret(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

/** Pull the token out of "Authorization: Bearer <token>". */
export function bearerToken(header: string | undefined): string {
  const h = header ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

/** Locks an address out after too many wrong secrets in a time window. */
export class FailureThrottle {
  private readonly failures = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit = 10,
    private readonly windowMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  blocked(ip: string): boolean {
    const rec = this.failures.get(ip);
    return Boolean(rec && rec.resetAt > this.now() && rec.count >= this.limit);
  }

  fail(ip: string): void {
    const now = this.now();
    const rec = this.failures.get(ip);
    const current = rec && rec.resetAt > now ? rec : { count: 0, resetAt: now + this.windowMs };
    current.count += 1;
    this.failures.set(ip, current);
    // Keep the map from growing without bound under a flood of distinct addresses.
    if (this.failures.size > 5000) {
      for (const [k, v] of this.failures) if (v.resetAt <= now) this.failures.delete(k);
    }
  }
}
