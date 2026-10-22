import type { DatabaseSync } from "node:sqlite";

/**
 * Lifecycle:
 *   pending -> executing -> executed
 *                        -> failed      (GitHub definitely did not do it; safe to propose again)
 *                        -> uncertain   (no response; we could not confirm either way)
 *   pending -> rejected | expired
 */
export type ActionStatus =
  | "pending"
  | "executing"
  | "executed"
  | "failed"
  | "uncertain"
  | "rejected"
  | "expired";

export interface ActionRecord {
  id: string;
  kind: "comment";
  prNumber: number;
  prTitle: string;
  prUrl: string;
  /** Exact text that will be posted (or was posted). */
  body: string;
  /** The draft as first proposed, kept only when an approver edited it before approving. Null = unchanged. */
  originalBody: string | null;
  status: ActionStatus;
  requestedBy: string;
  requestedVia: string;
  /** Why the agent suggests this (shown to the approver). */
  reason: string;
  createdAt: string;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  resultUrl: string | null;
  error: string | null;
}

interface Row {
  id: string;
  kind: string;
  pr_number: number;
  pr_title: string;
  pr_url: string;
  body: string;
  original_body: string | null;
  status: string;
  requested_by: string;
  requested_via: string;
  reason: string;
  created_at: string;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  result_url: string | null;
  error: string | null;
}

function toRecord(r: Row): ActionRecord {
  return {
    id: r.id,
    kind: r.kind as ActionRecord["kind"],
    prNumber: r.pr_number,
    prTitle: r.pr_title,
    prUrl: r.pr_url,
    body: r.body,
    originalBody: r.original_body ?? null,
    status: r.status as ActionStatus,
    requestedBy: r.requested_by,
    requestedVia: r.requested_via,
    reason: r.reason,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    resultUrl: r.result_url,
    error: r.error,
  };
}

export type NewAction = Pick<
  ActionRecord,
  | "id"
  | "kind"
  | "prNumber"
  | "prTitle"
  | "prUrl"
  | "body"
  | "requestedBy"
  | "requestedVia"
  | "reason"
  | "createdAt"
  | "expiresAt"
>;

export class ActionRepository {
  constructor(private readonly db: DatabaseSync) {}

  insert(a: NewAction): void {
    this.db
      .prepare(
        `INSERT INTO pending_actions
           (id, kind, pr_number, pr_title, pr_url, body, status, requested_by, requested_via,
            reason, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id,
        a.kind,
        a.prNumber,
        a.prTitle,
        a.prUrl,
        a.body,
        a.requestedBy,
        a.requestedVia,
        a.reason,
        a.createdAt,
        a.expiresAt,
      );
  }

  get(id: string): ActionRecord | null {
    const row = this.db.prepare("SELECT * FROM pending_actions WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? toRecord(row) : null;
  }

  list(statuses: ActionStatus[], limit = 50): ActionRecord[] {
    const marks = statuses.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_actions WHERE status IN (${marks}) ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...statuses, limit) as unknown as Row[];
    return rows.map(toRecord);
  }

  /**
   * Atomically move pending -> executing. Returns false if the action is not pending
   * or has expired, so a double tap (or two approvers) can never run it twice.
   *
   * `editedBody`: the approver changed the text. It replaces `body` in the SAME statement that wins the
   * claim, so the text that is posted is exactly the text that was approved, and a losing caller changes
   * nothing. The draft they were shown is kept in `original_body`.
   */
  claimForExecution(id: string, by: string, nowIso: string, editedBody: string | null = null): boolean {
    const res = this.db
      .prepare(
        `UPDATE pending_actions
            SET status = 'executing', decided_by = ?, decided_at = ?,
                original_body = CASE WHEN ? IS NOT NULL THEN body ELSE original_body END,
                body = CASE WHEN ? IS NOT NULL THEN ? ELSE body END
          WHERE id = ? AND status = 'pending' AND expires_at > ?`,
      )
      .run(by, nowIso, editedBody, editedBody, editedBody, id, nowIso);
    return Number(res.changes) === 1;
  }

  reject(id: string, by: string, nowIso: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE pending_actions
            SET status = 'rejected', decided_by = ?, decided_at = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(by, nowIso, id);
    return Number(res.changes) === 1;
  }

  /** Mark every pending action past its expiry. Returns how many changed. */
  expireOverdue(nowIso: string): number {
    const res = this.db
      .prepare(
        `UPDATE pending_actions SET status = 'expired'
          WHERE status = 'pending' AND expires_at <= ?`,
      )
      .run(nowIso);
    return Number(res.changes);
  }

  finish(
    id: string,
    status: "executed" | "failed" | "uncertain",
    detail: { resultUrl?: string | null; error?: string | null },
  ): void {
    this.db
      .prepare(`UPDATE pending_actions SET status = ?, result_url = ?, error = ? WHERE id = ?`)
      .run(status, detail.resultUrl ?? null, detail.error ?? null, id);
  }
}
