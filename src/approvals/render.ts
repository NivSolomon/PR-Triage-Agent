import type { ActionRecord } from "../store/actions.js";

/**
 * Plain-text approval card, shared by every channel so the approver always sees the same facts:
 * what will happen, on what, the exact text, why, who asked, and when it expires.
 */
export function renderApprovalCard(a: ActionRecord): string {
  return [
    `Approval needed (#${a.id.slice(0, 8)})`,
    ``,
    `Action: post ONE public comment on pull request #${a.prNumber}`,
    `PR: ${a.prTitle}`,
    `Link: ${a.prUrl}`,
    ``,
    `Exact comment text:`,
    a.body
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n"),
    ``,
    `Why the agent suggests it: ${a.reason || "(no reason given)"}`,
    `Requested by ${a.requestedBy} via ${a.requestedVia}`,
    `Expires: ${a.expiresAt}`,
    ``,
    `Nothing else will change. Without your approval nothing is posted.`,
  ].join("\n");
}

/** One-line, user-facing result of a decided action. */
export function renderOutcome(a: ActionRecord): string {
  switch (a.status) {
    case "executed":
      return `Posted the comment on #${a.prNumber}: ${a.resultUrl ?? a.prUrl}`;
    case "rejected":
      return `Rejected. Nothing was posted on #${a.prNumber}.`;
    case "expired":
      return `This request expired. Nothing was posted on #${a.prNumber}.`;
    case "failed":
      return `Approved, but the comment was NOT posted: ${a.error ?? "unknown error"} You can propose it again.`;
    case "uncertain":
      return `Approved, but I could not confirm the result: ${a.error ?? ""} Please check ${a.prUrl} before trying again.`;
    case "executing":
      return `Posting the comment on #${a.prNumber}…`;
    case "pending":
      return `Waiting for approval.`;
  }
}
