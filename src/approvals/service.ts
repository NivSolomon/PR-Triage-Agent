import { randomUUID } from "node:crypto";
import { isAmbiguousFailure } from "../github/client.js";
import type { GitHubClient } from "../github/client.js";
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

export const MAX_COMMENT_LENGTH = 2000;
const MAX_PENDING = 20;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

type GitHubPort = Pick<GitHubClient, "getPrSummary" | "postComment" | "findCommentWithMarker">;

export interface ApprovalServiceOptions {
  github: GitHubPort;
  repo: ActionRepository;
  /** Identity check, e.g. "telegram:123". The ONLY place approval rights are decided. */
  isApprover: (actorId: string) => boolean;
  now?: () => Date;
  newId?: () => string;
  ttlMs?: number;
}

export interface ProposeInput {
  prNumber: number;
  body: string;
  reason: string;
  /** Who/what asked, e.g. "telegram:123" or "mcp:reader-bot". Recorded for the approver. */
  requestedBy: string;
  /** Channel it came from: "telegram" | "mcp" | "web". */
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
  async propose(input: ProposeInput): Promise<ActionRecord> {
    const body = input.body.trim();
    if (!body) throw new ApprovalError("invalid_input", "The comment is empty.");
    if (body.length > MAX_COMMENT_LENGTH) {
      throw new ApprovalError(
        "invalid_input",
        `The comment is too long (${body.length} > ${MAX_COMMENT_LENGTH} characters).`,
      );
    }

    this.opts.repo.expireOverdue(this.now().toISOString());
    if (this.opts.repo.list(["pending"], MAX_PENDING + 1).length >= MAX_PENDING) {
      throw new ApprovalError(
        "too_many_pending",
        "Too many actions are waiting for approval. Approve or reject some first.",
      );
    }

    // Confirms the PR exists and captures its title/link for the approver's card.
    const pr = await this.opts.github.getPrSummary(input.prNumber);

    const createdAt = this.now();
    const record = {
      id: this.newId(),
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
    this.opts.repo.insert(record);
    return this.mustGet(record.id);
  }

  listPending(): ActionRecord[] {
    this.opts.repo.expireOverdue(this.now().toISOString());
    return this.opts.repo.list(["pending"]);
  }

  /** Latest actions in any state: the audit trail shown on the web page. */
  listRecent(limit = 20): ActionRecord[] {
    this.opts.repo.expireOverdue(this.now().toISOString());
    return this.opts.repo.list(
      ["pending", "executing", "executed", "failed", "uncertain", "rejected", "expired"],
      limit,
    );
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
    return this.mustGet(id);
  }

  /**
   * Approve and execute exactly this stored action. The text that is posted is the text
   * the approver saw: it is read from the stored record, never from the caller.
   */
  async approve(id: string, actorId: string): Promise<ActionRecord> {
    this.assertApprover(actorId);
    const action = this.opts.repo.get(id);
    if (!action) throw new ApprovalError("not_found", "No such action.");

    // Atomic claim: only one caller can move pending -> executing.
    if (!this.opts.repo.claimForExecution(id, actorId, this.now().toISOString())) {
      throw this.notPending(this.mustGet(id));
    }
    return this.execute(action);
  }

  private async execute(action: ActionRecord): Promise<ActionRecord> {
    const marker = actionMarker(action.id);
    const text = `${action.body}\n\n---\n_Posted by PR Triage Agent after human approval._\n${marker}`;
    try {
      const posted = await this.opts.github.postComment(action.prNumber, text);
      this.opts.repo.finish(action.id, "executed", { resultUrl: posted.url });
    } catch (err) {
      await this.recordFailure(action, marker, err);
    }
    return this.mustGet(action.id);
  }

  private async recordFailure(action: ActionRecord, marker: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);

    if (!isAmbiguousFailure(err)) {
      // GitHub answered with a clear refusal (or we failed before sending): nothing was posted.
      this.opts.repo.finish(action.id, "failed", { error: message });
      return;
    }

    // No (usable) response: the comment may or may not exist. Look for our marker before deciding.
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
          error: `${message} No matching comment was found on the pull request.`,
        });
      }
    } catch {
      this.opts.repo.finish(action.id, "uncertain", {
        error: `${message} Could not confirm whether the comment was posted. Check the pull request before trying again.`,
      });
    }
  }

  private assertApprover(actorId: string): void {
    if (!this.opts.isApprover(actorId)) {
      throw new ApprovalError("not_authorized", "You are not allowed to approve or reject actions.");
    }
  }

  private notPending(action: ActionRecord): ApprovalError {
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
