import { randomUUID } from "node:crypto";
import { GitHubError, isAmbiguousFailure } from "../github/client.js";
import type { GitHubWriter } from "../github/port.js";
import type { ActionRecord } from "../store/actions.js";
import { ActionRepository } from "../store/actions.js";

export type ApprovalErrorCode =
  | "not_authorized"
  | "not_found"
  | "not_pending"
  | "invalid_input"
  | "too_many_pending";

export class ApprovalError extends Error {
  constructor(
    readonly code: ApprovalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

const MAX_COMMENT_LENGTH = 2000;
const MAX_PENDING = 20;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface ApprovalServiceOptions {
  github: GitHubWriter;
  repo: ActionRepository;
  /** Identity check, e.g. "slack:U01ABC". The ONLY place approval rights are decided. */
  isApprover: (actorId: string) => boolean;
  now?: () => Date;
  newId?: () => string;
  ttlMs?: number;
  /**
   * Called when a request leaves `pending` without the clicker's Slack client knowing
   * (replaced, rejected on the web, expired, recovered after a crash). Used to retire
   * stale Approve buttons. Failures here must not change the stored outcome.
   */
  onRetired?: (records: ActionRecord[]) => Promise<void> | void;
}

export interface ProposeInput {
  prNumber: number;
  body: string;
  reason: string;
  /** Who/what asked, e.g. "slack:U01ABC" or "mcp:reader-bot". Recorded for the approver. */
  requestedBy: string;
  /** Channel it came from: "slack" | "mcp" | "web". */
  via: string;
}

export function actionMarker(id: string): string {
  return `<!-- pr-triage-agent:${id} -->`;
}

export class ApprovalService {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly ttlMs: number;

  constructor(private readonly opts: ApprovalServiceOptions) {
    this.now = opts.now ?? (() => new Date());
    this.newId = opts.newId ?? randomUUID;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Record a proposed comment. This NEVER calls GitHub to write: it only stores a pending
   * action that a human approver must explicitly approve.
   */
  /**
   * Record a proposed comment. Never writes to GitHub. If this person already has a pending
   * comment on the same PR, those older drafts are withdrawn (`superseded`) so they cannot be posted.
   */
  async propose(input: ProposeInput): Promise<{ record: ActionRecord; replaced: ActionRecord[] }> {
    const body = this.validateBody(input.body);

    this.flushExpired();

    // Confirms the PR exists, is still open, and captures its title/link for the approver's card.
    const pr = await this.opts.github.getPrSummary(input.prNumber);
    const blocked = this.notCommentable(pr);
    if (blocked) throw new ApprovalError("invalid_input", blocked);

    const unsafe = this.opts.repo
      .list(["executing", "uncertain"], 50)
      .filter((a) => a.prNumber === pr.number);
    if (unsafe[0]) {
      throw new ApprovalError(
        "invalid_input",
        unsafe[0].status === "executing"
          ? `A comment on #${pr.number} is still being posted. Wait for that to finish before proposing another.`
          : `A comment on #${pr.number} was approved but could not be confirmed. Check ${pr.sourceUrl} before proposing another, so a duplicate is not posted.`,
      );
    }

    const open = this.opts.repo.list(["pending"], MAX_PENDING + 1);
    const replacing = open.filter((a) => a.requestedBy === input.requestedBy && a.prNumber === pr.number);
    // Replacing your own draft on this PR does not consume an extra slot.
    if (open.length - replacing.length >= MAX_PENDING) {
      throw new ApprovalError(
        "too_many_pending",
        "Too many actions are waiting for approval. Approve or reject some first.",
      );
    }

    const createdAt = this.now();
    const id = this.newId();
    const record = {
      id,
      kind: "comment" as const,
      prNumber: pr.number,
      prTitle: pr.title,
      prUrl: pr.sourceUrl,
      body,
      requestedBy: input.requestedBy,
      requestedVia: input.via,
      reason: input.reason.trim().slice(0, 500),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.ttlMs).toISOString(),
    };
    const replaced = this.opts.repo.runInTransaction(() => {
      this.opts.repo.insert(record);
      return this.opts.repo.supersedeOpen(
        input.requestedBy,
        pr.number,
        id,
        createdAt.toISOString(),
        `Replaced by request ${id}`,
      );
    });
    await this.notifyRetired(replaced);
    return { record: this.mustGet(id), replaced };
  }

  listPending(): ActionRecord[] {
    this.flushExpired();
    return this.opts.repo.list(["pending"]);
  }

  /**
   * Audit trail for the web page: every still-open request (pending / posting), then a capped
   * history. A busy history must not hide a request that can still be approved.
   */
  listRecent(historyLimit = 20): ActionRecord[] {
    this.flushExpired();
    const live = this.opts.repo.list(["pending", "executing"], MAX_PENDING + 10);
    const history = this.opts.repo.list(
      ["executed", "failed", "uncertain", "rejected", "expired", "superseded"],
      historyLimit,
    );
    const seen = new Set(live.map((a) => a.id));
    return [...live, ...history.filter((a) => !seen.has(a.id))];
  }

  get(id: string): ActionRecord | null {
    return this.opts.repo.get(id);
  }

  async reject(id: string, actorId: string): Promise<ActionRecord> {
    this.assertApprover(actorId);
    const action = this.opts.repo.get(id);
    if (!action) throw new ApprovalError("not_found", "No such action.");
    if (!this.opts.repo.reject(id, actorId, this.now().toISOString())) {
      throw this.notPending(this.mustGet(id));
    }
    const done = this.mustGet(id);
    await this.notifyRetired([done]);
    return done;
  }

  /**
   * Approve and execute this stored action. By default the text posted is the stored text the approver saw.
   *
   * An approver may pass `editedBody` to correct the draft first. That is still a human decision about an
   * exact text: it is checked like any proposal, applied in the same atomic step that claims the action,
   * and the original draft is kept. It can only come from an approver (checked first) and never from a
   * proposer, so nobody can use the edit to slip different text past the person who approves.
   */
  async approve(id: string, actorId: string, opts: { editedBody?: string } = {}): Promise<ActionRecord> {
    this.assertApprover(actorId);
    const action = this.opts.repo.get(id);
    if (!action) throw new ApprovalError("not_found", "No such action.");

    let edited: string | null = null;
    if (opts.editedBody !== undefined) {
      const body = this.validateBody(opts.editedBody);
      if (body !== action.body) edited = body; // identical text is not an edit
    }

    const blocked = await this.notCommentableNow(action.prNumber);
    if (blocked) {
      if (this.opts.repo.failIfPending(id, blocked)) {
        const done = this.mustGet(id);
        await this.notifyRetired([done]);
        return done;
      }
      // A concurrent claim won; that caller re-checks in execute().
    }

    // Atomic claim: only one caller can move pending -> executing.
    if (!this.opts.repo.claimForExecution(id, actorId, this.now().toISOString(), edited)) {
      throw this.notPending(this.mustGet(id));
    }
    // Read the claimed row back: it holds the text that was actually approved.
    return this.execute(this.mustGet(id));
  }

  rememberCard(actionId: string, channel: string, ts: string): void {
    this.opts.repo.rememberCard(actionId, channel, ts);
  }

  cardsFor(actionId: string): { channel: string; ts: string }[] {
    return this.opts.repo.cardsFor(actionId);
  }

  /**
   * After a crash mid-post, rows can be left in `executing`. Look up the hidden marker and
   * record executed / failed / uncertain. Never posts a second comment.
   */
  async recoverInterrupted(): Promise<ActionRecord[]> {
    const stuck = this.opts.repo.list(["executing"], 100);
    const recovered: ActionRecord[] = [];
    for (const action of stuck) {
      try {
        await this.reconcile(action, "Process restarted before this post was confirmed.");
      } catch (err) {
        console.error(
          `Could not reconcile interrupted action ${action.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
      const row = this.opts.repo.get(action.id);
      if (row) recovered.push(row);
    }
    await this.notifyRetired(recovered.filter((a) => a.status !== "executing"));
    return recovered;
  }

  private validateBody(raw: string): string {
    // HTML comments in GitHub markdown hide everything after an unclosed `<!--`, including our
    // audit footer and marker. Strip them so the posted text cannot swallow what follows.
    const body = raw
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<!--[\s\S]*/g, "")
      .trim();
    if (!body) throw new ApprovalError("invalid_input", "The comment is empty.");
    if (body.length > MAX_COMMENT_LENGTH) {
      throw new ApprovalError(
        "invalid_input",
        `The comment is too long (${body.length} > ${MAX_COMMENT_LENGTH} characters).`,
      );
    }
    return body;
  }

  private async execute(action: ActionRecord): Promise<ActionRecord> {
    const marker = actionMarker(action.id);
    const text = `${action.body}\n\n---\n_Posted by PR Triage Agent after human approval._\n${marker}`;
    try {
      const blocked = await this.notCommentableNow(action.prNumber);
      if (blocked) {
        this.opts.repo.finish(action.id, "failed", { error: blocked });
      } else {
        const posted = await this.opts.github.postComment(action.prNumber, text);
        this.opts.repo.finish(action.id, "executed", { resultUrl: posted.url });
      }
    } catch (err) {
      await this.recordFailure(action, err);
    }
    const done = this.mustGet(action.id);
    await this.notifyRetired([done]);
    return done;
  }

  private async recordFailure(action: ActionRecord, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);

    if (!isAmbiguousFailure(err)) {
      // GitHub answered with a clear refusal (or we failed before sending): nothing was posted.
      this.opts.repo.finish(action.id, "failed", { error: message });
      return;
    }

    await this.reconcile(action, message);
  }

  /** Look up the hidden marker and record executed / failed / uncertain. Never posts. */
  private async reconcile(action: ActionRecord, prefix: string): Promise<void> {
    const marker = actionMarker(action.id);
    try {
      const found = await this.opts.github.findCommentWithMarker(
        action.prNumber,
        marker,
        action.createdAt,
      );
      if (found) {
        this.opts.repo.finish(action.id, "executed", { resultUrl: found.url });
      } else {
        this.opts.repo.finish(action.id, "failed", {
          error: `${prefix} No matching comment was found on the pull request.`,
        });
      }
    } catch {
      this.opts.repo.finish(action.id, "uncertain", {
        error: `${prefix} Could not confirm whether the comment was posted. Check the pull request before trying again.`,
      });
    }
  }

  private notCommentable(pr: { number: number; state?: string; locked?: boolean }): string | null {
    if (pr.locked) return `Pull request #${pr.number} is locked. Nothing was posted.`;
    if ((pr.state ?? "open") !== "open") {
      return `Pull request #${pr.number} is ${pr.state}. Nothing was posted.`;
    }
    return null;
  }

  /** Null = still open (or we could not tell). A string is a definite reason not to post. */
  private async notCommentableNow(prNumber: number): Promise<string | null> {
    try {
      return this.notCommentable(await this.opts.github.getPrSummary(prNumber));
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) {
        return `Pull request #${prNumber} was not found. Nothing was posted.`;
      }
      // Network / 5xx: do not guess. The caller may still try to post, or leave the row pending.
      return null;
    }
  }

  private flushExpired(): void {
    void this.notifyRetired(this.opts.repo.expireOverdue(this.now().toISOString()));
  }

  private notifyRetired(records: ActionRecord[]): Promise<void> {
    if (records.length === 0) return Promise.resolve();
    return Promise.resolve(this.opts.onRetired?.(records)).then(
      () => undefined,
      (err) => {
        console.error("Could not update Slack cards:", err instanceof Error ? err.message : err);
      },
    );
  }

  private assertApprover(actorId: string): void {
    if (!this.opts.isApprover(actorId)) {
      throw new ApprovalError("not_authorized", "You are not allowed to approve or reject actions.");
    }
  }

  private notPending(action: ActionRecord): ApprovalError {
    if (action.status === "superseded") {
      return new ApprovalError(
        "not_pending",
        `This draft was replaced by a newer request. Nothing was posted on #${action.prNumber}.`,
      );
    }
    return new ApprovalError(
      "not_pending",
      `This action is already ${action.status}; it was not run again.`,
    );
  }

  private mustGet(id: string): ActionRecord {
    const a = this.opts.repo.get(id);
    if (!a) throw new Error(`Action ${id} vanished`);
    return a;
  }
}
