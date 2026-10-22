/**
 * The "what can I do here?" guide, written once and shown in Slack (`/triage help`) and on the web page.
 * Keeping one source means the two channels can never promise different things, and the promises
 * here are the same rules the code enforces (see approvals/service.ts and agent/tools.ts).
 */

/** Approvers can decide on requests; everyone else who may chat can only ask. */
export type GuideAudience = "approver" | "requester";

export interface GuideSection {
  title: string;
  /** can = things you may do, cannot = things nobody can do, rule = how the approval works. */
  tone: "can" | "cannot" | "rule";
  items: string[];
}

export interface Guide {
  /** One sentence saying who you are to the agent, so the limits are clear at a glance. */
  youAre: string;
  sections: GuideSection[];
}

export interface GuideOptions {
  /** Where the reader is, so "where do I approve?" points at something they can actually click. */
  channel: "slack" | "web";
}

export function buildGuide(audience: GuideAudience, opts: GuideOptions): Guide {
  const approver = audience === "approver";
  const where = opts.channel === "slack"
    ? "Slack: the approval card the app sends you as a direct message, or the web page with the approver key"
    : "the Approvals panel on this page (Slack approvers also get a card in their direct messages)";

  const youAre = approver
    ? "You are an APPROVER. You can ask questions, request comments, and approve or reject requests."
    : "You can ASK questions and REQUEST comments, but you cannot approve. An approver decides.";

  const can: string[] = [
    "See the open pull requests ranked by what to review first, with the reasons, a confidence level and a link to each (no AI credit used).",
    "Ask in plain language: what is blocked and why, what is ready to merge, what is stale, what one PR is about, its CI status, reviews and branches.",
    "Ask for a comment to be left on a pull request. The agent only drafts it: nothing is posted until an approver approves it (an approver may correct the wording first).",
    "Read the morning digest the agent sends on weekdays without being asked (in the team's digest channel, or as a direct message to approvers). You can also ask for it any time.",
  ];
  if (approver) {
    can.push(`Approve or reject a comment request: ${where}. Approving asks you to confirm once more, because a public comment cannot be unposted.`);
  }

  return {
    youAre,
    sections: [
      { title: "What you can do", tone: "can", items: can },
      {
        title: "What nobody can do, approvers included",
        tone: "cannot",
        items: [
          "The agent never posts, merges, closes, approves or edits a pull request by itself. Its only write is one comment, and only after a human approves it.",
          "It cannot see the code diff or the CI logs. It sees titles, descriptions, branch names, file and line counts, check names, reviews and comments, so it says so instead of guessing what changed or why CI failed.",
          "It works on one repository and answers only about its pull requests.",
        ],
      },
      {
        title: "How approval works",
        tone: "rule",
        items: approver
          ? [
              "A request shows you the exact comment, the pull request, why it was suggested, who asked, and when it expires.",
              "What you approve is what is posted. You can correct the wording first (Edit text): your corrected text is then what is posted, and the original draft is kept in the history. Once you approve, the text cannot change.",
              "Pressing Approve twice, or two approvers pressing it, still posts once. A request that nobody decides expires after 24 hours and posts nothing.",
            ]
          : [
              "Your request goes to the approvers with the exact text. An approver may correct the wording before approving; the history keeps the original draft and shows what was posted. You can follow it: Slack tells you when an approver decides, and the web page History lists every request and its status.",
              "A request that nobody decides expires after 24 hours and posts nothing.",
              "Programs that connect to this agent (MCP) are limited the same way: they can look, ask, and at most request a comment, never approve one.",
            ],
      },
      {
        title: "Limits",
        tone: "rule",
        items: [
          "Each person has a daily limit on AI questions, and the team shares a monthly AI budget. When it runs low the agent gives shorter answers; when it is used up it pauses AI answers.",
          "The ranked queue, the digest and the budget status need no AI credit, so they keep working even then.",
        ],
      },
    ],
  };
}

/** Plain text for chat apps (Slack messages here are sent with formatting off). */
export function renderGuideText(g: Guide): string {
  const lines: string[] = [g.youAre, ""];
  for (const s of g.sections) {
    lines.push(`${s.title}:`);
    for (const item of s.items) lines.push(`- ${item}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}
