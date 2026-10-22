import type { KnownBlock } from "@slack/types";
import { buildGuide } from "../guide.js";
import type { GuideAudience } from "../guide.js";
import { SLACK_COMMANDS, SLACK_EXAMPLES } from "../prompts/bank.js";
import { slackSafe } from "./slack-text.js";

/** A section's text is limited to 3000 characters; stay clear of it. */
const TEXT_MAX = 2800;

const text = (mrkdwn: string): KnownBlock => ({
  type: "section",
  text: { type: "mrkdwn", text: slackSafe(mrkdwn).slice(0, TEXT_MAX) },
});

const bullets = (items: string[]): string => items.map((i) => `\u2022 ${i}`).join("\n");

/**
 * The app's Home tab: a guide that is always there, written from the same source as `/triage help`
 * and the web page. Everything is escaped, and nothing here calls the model.
 */
export function homeBlocks(o: { repo: string; audience: GuideAudience; budgetLevel?: string; pending?: number }): KnownBlock[] {
  const guide = buildGuide(o.audience, { channel: "slack" });
  const blocks: KnownBlock[] = [
    { type: "header", text: { type: "plain_text", text: "PR Triage Agent", emoji: false } },
    text(`I help your team decide *which pull requests to review first, and why*, using live GitHub data from \`${o.repo}\`. I only post a comment after a human approves that exact text.`),
    { type: "context", elements: [{ type: "mrkdwn", text: slackSafe(guide.youAre) }] },
    { type: "divider" },
    text(
      `*How to talk to me*\n${bullets([
        "Open the *Messages* tab and write to me. Your questions and my answers stay in one conversation.",
        "In a channel, @mention me and I reply in a thread.",
      ])}`,
    ),
    text(`*Try asking*\n${bullets(SLACK_EXAMPLES.map((e) => `\u201C${e}\u201D`))}`),
    text(`*Quick commands* (private to you, no conversation needed)\n${bullets(SLACK_COMMANDS.map(([c, d]) => `\`${c}\` ${d}`))}`),
    { type: "divider" },
  ];
  for (const s of guide.sections) blocks.push(text(`*${s.title}*\n${bullets(s.items)}`));

  const status: string[] = [];
  if (o.budgetLevel) status.push(`AI budget mode: ${o.budgetLevel}`);
  if (o.pending !== undefined) status.push(`Requests waiting for approval: ${o.pending}`);
  if (status.length > 0) {
    blocks.push({ type: "divider" }, { type: "context", elements: [{ type: "mrkdwn", text: slackSafe(status.join("   |   ")) }] });
  }
  return blocks;
}

/** What someone who is not on the access list sees on the Home tab. */
export function homeDeniedBlocks(userId: string): KnownBlock[] {
  return [
    { type: "header", text: { type: "plain_text", text: "PR Triage Agent", emoji: false } },
    text(
      `You are not on the access list yet. Send your Slack member ID to the workspace admin to be added:\n\`${userId}\``,
    ),
  ];
}
