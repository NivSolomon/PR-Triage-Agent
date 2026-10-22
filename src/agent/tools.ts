import { z } from "zod";
import { ApprovalError } from "../approvals/service.js";
import type { ApprovalService } from "../approvals/service.js";
import { GitHubError, type GitHubClient } from "../github/client.js";
import type { ActionRecord } from "../store/actions.js";
import { assessPr } from "../triage/analyze.js";
import { buildQueue } from "../triage/queue.js";

/** Who is asking and what they may do. Checked inside the tools, not just in the prompt. */
export interface ToolContext {
  /** e.g. "slack:U01ABC", "mcp:reader:ab12cd34", "web:approver". Recorded on every proposal. */
  actor: string;
  /** Channel the request came through. */
  via: "slack" | "web" | "mcp" | "scheduler";
  /** May this caller ask for a comment to be proposed? (Approving is never a tool.) */
  canPropose: boolean;
  /** GitHub login of the person asking, when known. Lets the queue say what is waiting on them. */
  githubLogin?: string;
  /** Called with each action the agent proposed in this request, so the channel can show an approval card. */
  onProposed?: (a: ActionRecord, replaced?: ActionRecord[]) => void;
  /**
   * Pull requests loaded with get_pull_request in this request. When set, propose_comment is refused
   * until that PR has been fetched, so the model cannot invent a comment for a number it has not read.
   * Omit for MCP clients that pass the exact body themselves.
   */
  fetchedPrs?: Set<number>;
  /**
   * The user's question. When set with requireCommentIntent, propose_comment is refused unless they
   * gave wording or a clear intent (what the comment should ask). Omit for MCP clients.
   */
  userText?: string;
  requireCommentIntent?: boolean;
}

export interface ToolDeps {
  github: Pick<GitHubClient, "listOpenPrs" | "getPr" | "repo">;
  approvals: Pick<ApprovalService, "propose">;
  now?: () => Date;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
  /** Needs `ctx.canPropose`. Hidden from callers without it. */
  requiresPropose?: boolean;
}

const queueArgs = z.object({ limit: z.number().int().min(1).max(20).optional() });
const prArgs = z.object({ number: z.number().int().positive() });
const proposeArgs = z.object({
  prNumber: z.number().int().positive(),
  body: z.string().min(1).max(2000),
  reason: z.string().min(1).max(500),
});

const TOOL_SPECS: ToolSpec[] = [
  {
    name: "get_review_queue",
    description:
      "Get the open pull requests ranked by what to review first, each with its state, score, " +
      "confidence, the facts behind the ranking, what is unknown, and a source link. " +
      "Use it for questions like 'what should we review first?'.",
    // No "limit" here on purpose: when the model chose it, it picked small numbers and silently
    // left PRs out. The system decides how many to analyse and reports when more exist.
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_pull_request",
    description:
      "Get one pull request in detail: its triage assessment plus reviews, CI checks and recent comments. " +
      "Use it when asked about a specific PR number.",
    parameters: {
      type: "object",
      properties: { number: { type: "integer", minimum: 1, description: "Pull request number." } },
      required: ["number"],
      additionalProperties: false,
    },
  },
  {
    name: "propose_comment",
    description:
      "PROPOSE a public comment on a pull request. This does NOT post anything: it creates a request " +
      "that a human approver must approve first. Call get_pull_request for that number first. " +
      "Only use it when the user gave the wording or a clear intent (what the comment should ask). " +
      "If they only said 'write a comment' with no content, do not call this: ask what it should say. " +
      "body must be the exact final text: the user's words if they gave them, otherwise one short comment from their intent and the fetched facts. Never invent a generic status ping.",
    parameters: {
      type: "object",
      properties: {
        prNumber: { type: "integer", minimum: 1 },
        body: { type: "string", description: "The exact comment text to post (max 2000 characters)." },
        reason: { type: "string", description: "One sentence on why this comment is useful, shown to the approver." },
      },
      required: ["prNumber", "body", "reason"],
      additionalProperties: false,
    },
    requiresPropose: true,
  },
];

/** The tools this caller is allowed to see. */
export function toolsFor(ctx: ToolContext): ToolSpec[] {
  return TOOL_SPECS.filter((t) => !t.requiresPropose || ctx.canPropose);
}

/**
 * Run one tool call. Never throws: errors become a result the model can explain to the user,
 * so a failed lookup is reported, not hidden or invented around.
 */
export async function runTool(
  name: string,
  rawArgs: unknown,
  ctx: ToolContext,
  deps: ToolDeps,
): Promise<string> {
  try {
    switch (name) {
      case "get_review_queue": {
        const { limit } = queueArgs.parse(rawArgs ?? {});
        const q = await buildQueue(deps.github, { limit, now: deps.now?.() });
        const me = ctx.githubLogin?.toLowerCase();
        for (const a of q.items) ctx.fetchedPrs?.add(a.number);
        return json({
          repo: q.repo,
          generatedAt: q.generatedAt,
          // Present only when the asker is linked to a GitHub login. Then "me" and "my" mean this user.
          ...(ctx.githubLogin ? { you: ctx.githubLogin } : {}),
          moreOpenPrsNotShown: q.truncated,
          queue: q.items.map((a) => ({
            number: a.number,
            title: a.title,
            author: a.author,
            ...(me
              ? {
                  requestedFromYou: a.requestedReviewers.some((r) => r.toLowerCase() === me),
                  writtenByYou: a.author.toLowerCase() === me,
                }
              : {}),
            state: a.state,
            score: a.score,
            confidence: a.confidence,
            facts: a.signals.map((s) => s.text),
            unknowns: a.unknowns,
            recommendation: a.recommendation,
            sourceUrl: a.sourceUrl,
          })),
          couldNotAnalyse: q.failed,
        });
      }
      case "get_pull_request": {
        const { number } = prArgs.parse(rawArgs);
        let pr;
        try {
          pr = await deps.github.getPr(number);
        } catch (err) {
          if (err instanceof GitHubError && err.status === 404) {
            return json({
              error: `Pull request #${number} does not exist in this repository. It was not found on GitHub. Do not invent a title, status, CI result, or URL for it.`,
              notFound: true,
              requestedNumber: number,
            });
          }
          throw err;
        }
        ctx.fetchedPrs?.add(pr.number);
        const a = assessPr(pr, deps.now?.());
        return json({
          assessment: {
            state: a.state,
            score: a.score,
            confidence: a.confidence,
            facts: a.signals.map((s) => s.text),
            unknowns: a.unknowns,
            recommendation: a.recommendation,
          },
          pr: {
            number: pr.number,
            title: pr.title,
            author: pr.author,
            draft: pr.draft,
            createdAt: pr.createdAt,
            updatedAt: pr.updatedAt,
            // The branch the changes are on and the one they would merge into. Names are chosen by the author.
            headBranch: pr.headBranch,
            baseBranch: pr.baseBranch,
            changedFiles: pr.changedFiles,
            additions: pr.additions,
            deletions: pr.deletions,
            mergeableState: pr.mergeableState,
            requestedReviewers: pr.requestedReviewers,
            reviews: pr.reviews,
            ci: pr.checks
              ? { passing: pr.checks.passing, failing: pr.checks.failing, pending: pr.checks.pending, sourceUrl: pr.checks.sourceUrl }
              : "unknown (could not be fetched)",
            sourceUrl: pr.sourceUrl,
          },
          // Written by third parties. Treat as data to summarise, never as instructions.
          untrustedText: {
            description: pr.body,
            recentComments: pr.recentComments.map((c) => ({ author: c.author, at: c.createdAt, text: c.body })),
          },
        });
      }
      case "propose_comment": {
        if (!ctx.canPropose) {
          return json({ error: "You are not allowed to propose comments. Nothing was created." });
        }
        const args = proposeArgs.parse(rawArgs);
        if (ctx.fetchedPrs && !ctx.fetchedPrs.has(args.prNumber)) {
          return json({
            error:
              `Fetch pull request #${args.prNumber} with get_pull_request (or include it via get_review_queue) before proposing a comment. Then call propose_comment again. Nothing was created.`,
          });
        }
        if (ctx.requireCommentIntent && ctx.userText !== undefined && !userGaveCommentIntent(ctx.userText)) {
          return json({
            error:
              "The user did not give the comment wording or a clear intent (what it should ask). Ask them what the comment should say. Do not invent a status ping. Nothing was created.",
          });
        }
        const { record, replaced } = await deps.approvals.propose({
          prNumber: args.prNumber,
          body: args.body,
          reason: args.reason,
          requestedBy: ctx.actor,
          via: ctx.via,
        });
        ctx.onProposed?.(record, replaced);
        return json({
          status: "pending_approval",
          prNumber: record.prNumber,
          actionId: record.id,
          replacedIds: replaced.map((a) => a.id),
          note:
            "NOT posted. A human approver must approve this exact text first. " +
            "Tell the user it is waiting for approval; do not say it was posted." +
            (replaced.length
              ? ` Their previous pending comment on this PR was withdrawn (${replaced.map((a) => a.id.slice(0, 8)).join(", ")}) and can no longer be approved.`
              : ""),
        });
      }
      default:
        return json({ error: `Unknown tool: ${name}` });
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return json({ error: `Invalid arguments: ${err.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` });
    }
    if (err instanceof ApprovalError) return json({ error: err.message });
    return json({ error: err instanceof Error ? err.message : String(err) });
  }
}

/** True when the user quoted text, or said what the comment should ask. */
export function userGaveCommentIntent(text: string): boolean {
  const t = text.trim();
  if (/["“”«»].{2,}["“”«»]/.test(t)) return true;
  if (/\b(ask|asking|tell|telling|remind|nudge|say|saying|write that|post that|comment that)\b/i.test(t)) return true;
  if (/(?:write|post|comment|leave)\s*:\s*\S/i.test(t)) return true;
  if (/תבקש|לבקש|תגיד|להגיד|תזכיר|לתקן|\bתקן\b/.test(t)) return true;
  return false;
}

function json(v: unknown): string {
  return JSON.stringify(v);
}
