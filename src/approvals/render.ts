import type { ActionRecord } from "../store/actions.js";

/** True when the draft would notify someone on GitHub (`@login` at a word boundary, not an email). */
export function containsAtMention(body: string): boolean {
  return /(^|[^A-Za-z0-9_])@[A-Za-z0-9]/.test(body);
}

/**
 * Plain-text approval card, shared by every channel so the approver always sees the same facts:
 * what will happen, on what, the exact text, why, who asked, and when it expires.
 */
export function renderApprovalCard(a: ActionRecord): string {
  return [
    `Approval needed (#${a.id.slice(0, 8)})`,
    ``,
    `Action: post one public comment on pull request #${a.prNumber}`,
    `PR: ${a.prTitle}`,
    `Link: ${a.prUrl}`,
    ``,
    `Exact comment text:`,
    a.body
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n"),
    ``,
    ...(containsAtMention(a.body)
      ? [`This comment @-mentions someone. Approving will notify them on GitHub.`, ``]
      : []),
    ...(a.originalBody
      ? [
          `Edited by the approver before posting. The original draft was:`,
          ...a.originalBody.split("\n").map((l) => `| ${l}`),
          ``,
        ]
      : []),
    `Why the agent suggests it: ${a.reason || "(no reason given)"}`,
    `Requested by ${a.requestedBy} via ${a.requestedVia}`,
    `Expires: ${a.expiresAt}`,
    ``,
    `Nothing else will change. Without your approval, nothing is posted.`,
  ].join("\n");
}

/** True when a request was withdrawn because the PR can no longer take a comment. */
export function isUncommentableFailure(error: string | null | undefined): boolean {
  return Boolean(error && /is (closed|merged|locked)|was not found/i.test(error));
}

/** One-line, user-facing result of a decided action. */
export function renderOutcome(a: ActionRecord): string {
  switch (a.status) {
    case "executed":
      return `Posted ${a.originalBody ? "your edited" : "the"} comment on #${a.prNumber}: ${a.resultUrl ?? a.prUrl}`;
    case "rejected":
      return `Rejected. Nothing was posted on #${a.prNumber}.`;
    case "superseded":
      return `This draft was replaced by a newer request. Nothing was posted on #${a.prNumber}.`;
    case "expired":
      return `This request expired. Nothing was posted on #${a.prNumber}.`;
    case "failed":
      if (isUncommentableFailure(a.error)) {
        return a.error ?? `Pull request #${a.prNumber} is no longer open. Nothing was posted.`;
      }
      return `Approved, but the comment was not posted: ${a.error ?? "unknown error"}. You can propose it again.`;
    case "uncertain":
      return `Approved, but I could not confirm the result: ${a.error ?? "the outcome is unknown"}. Please check ${a.prUrl} before trying again.`;
    case "executing":
      return `Posting the comment on #${a.prNumber}…`;
    case "pending":
      return `Waiting for approval.`;
  }
}
