import type { PrDetail, PrSummary } from "./types.js";

/**
 * Read-only GitHub surface. Queue, digest, chat, web and the agent's lookup tools
 * depend on this — they never post a comment.
 */
export interface GitHubReader {
  readonly repo: string;
  listOpenPrs(limit?: number): Promise<PrSummary[]>;
  getPr(number: number): Promise<PrDetail>;
}

/**
 * Writes and the lookups approval needs to post once and recover after a crash.
 * Only ApprovalService depends on this.
 */
export interface GitHubWriter {
  getPrSummary(number: number): Promise<PrSummary>;
  postComment(number: number, body: string): Promise<{ id: number; url: string }>;
  findCommentWithMarker(number: number, marker: string, since: string): Promise<{ id: number; url: string } | null>;
}

/** The real client implements both. Callers still take the sliver they need. */
export type GitHubPort = GitHubReader & GitHubWriter;
