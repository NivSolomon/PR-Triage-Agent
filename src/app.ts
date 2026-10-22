import type { Server } from "node:http";
import { Agent } from "./agent/agent.js";
import { OpenAiLlm } from "./agent/llm.js";
import { ApprovalService } from "./approvals/service.js";
import { BudgetService } from "./budget/service.js";
import { SlackChannel } from "./channels/slack.js";
import { requireConfig } from "./config.js";
import type { Config } from "./config.js";
import { GitHubClient } from "./github/client.js";
import { createMcpRouter } from "./mcp/server.js";
import { runDigest, startDigestSchedule } from "./scheduler/digest.js";
import type { SchedulerHandle } from "./scheduler/digest.js";
import { createWebApp } from "./web/server.js";
import { ActionRepository } from "./store/actions.js";
import { openDatabase } from "./store/db.js";
import { RunRepository } from "./store/runs.js";

const WEB_APPROVER_ACTOR = "web:approver";

export interface App {
  config: Config;
  github: GitHubClient;
  approvals: ApprovalService;
  budget: BudgetService;
  agent: Agent;
  slack: SlackChannel;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Who may approve. The ONLY definition of approval rights; every channel goes through it. */
export function makeIsApprover(config: Config): (actorId: string) => boolean {
  const allowed = new Set(config.SLACK_APPROVER_USER_IDS.map((id) => `slack:${id}`));
  // The web approver identity exists only if an approver key is configured.
  if (config.WEB_APPROVER_KEY) allowed.add(WEB_APPROVER_ACTOR);
  // Each named web user with the approver role is their own approver identity.
  for (const u of config.WEB_USERS) if (u.role === "approver") allowed.add(`web:${u.name}`);
  const slackAll = config.SLACK_ALLOW_ALL_MEMBERS;
  return (actorId) => {
    if (allowed.has(actorId)) return true;
    // A workspace invite is then enough to Approve/Reject in Slack (testers). Slack Connect
    // is refused in the Slack adapter (workspace id) before this is called. MCP and web readers never match.
    return slackAll === true && /^slack:[UW][A-Z0-9]{2,}$/.test(actorId);
  };
}

/** Wire every part together. Fails fast with a clear message if a required secret is missing. */
export function createApp(config: Config): App {
  const env = requireConfig(config, [
    "GITHUB_TOKEN",
    "GITHUB_REPO",
    "LLM_API_KEY",
    "SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN",
  ] as const);

  const db = openDatabase(config.DATABASE_PATH);
  const github = new GitHubClient({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO });
  const budget = new BudgetService({
    db,
    monthlyBudgetUsd: config.MONTHLY_BUDGET_USD,
    hostingUsd: config.HOSTING_COST_USD,
    pricePerMInput: config.LLM_PRICE_INPUT_PER_M,
    pricePerMOutput: config.LLM_PRICE_OUTPUT_PER_M,
    dailyRequestsPerActor: config.DAILY_REQUESTS_PER_USER,
  });
  const slackRef: { current?: SlackChannel } = {};
  const approvals = new ApprovalService({
    github,
    repo: new ActionRepository(db),
    isApprover: makeIsApprover(config),
    onRetired: (records) => slackRef.current?.retireCards(records) ?? Promise.resolve(),
  });

  // Late-bound: the agent needs a way to alert the team, the channel needs the agent.
  let notify: (text: string) => Promise<void> = async () => undefined;
  const agent = new Agent({
    llm: new OpenAiLlm(env.LLM_API_KEY, config.LLM_BASE_URL, config.LLM_MODEL),
    tools: { github, approvals },
    budget,
    notifyTeam: (text) => notify(text),
  });

  const slack = new SlackChannel({
    botToken: env.SLACK_BOT_TOKEN,
    appToken: env.SLACK_APP_TOKEN,
    allowedIds: config.SLACK_ALLOWED_USER_IDS,
    allowAllMembers: config.SLACK_ALLOW_ALL_MEMBERS,
    approverIds: config.SLACK_APPROVER_USER_IDS,
    teamChannelId: config.SLACK_DIGEST_CHANNEL_ID,
    githubUsers: config.SLACK_GITHUB_USERS,
    agent,
    approvals,
    github,
    budget,
  });
  slackRef.current = slack;
  notify = (text) => slack.notifyApprovers(text);

  /** Where scheduled messages go: the digest channel if set, otherwise every approver (as a DM). */
  const sendToTeam = async (text: string): Promise<void> => {
    if (config.SLACK_DIGEST_CHANNEL_ID) await slack.send(config.SLACK_DIGEST_CHANNEL_ID, text);
    else await slack.notifyApprovers(text);
  };

  const runs = new RunRepository(db);
  // The schedule starts later (in start()), after the web app exists, so the page reads the next run through this.
  let schedule: SchedulerHandle | undefined;

  const web = createWebApp({
    digest: {
      cron: config.DIGEST_CRON,
      timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
      target: config.SLACK_DIGEST_CHANNEL_ID
        ? "the team's Slack digest channel"
        : "a Slack direct message to each approver",
      nextRun: () => schedule?.nextRun() ?? null,
      runs,
    },
    users: config.WEB_USERS,
    sessionDb: db,
    trustProxy: config.TRUST_PROXY,
    maxFailures: config.AUTH_MAX_FAILURES,
    accessKey: config.WEB_ACCESS_KEY,
    approverKey: config.WEB_APPROVER_KEY,
    approverActor: WEB_APPROVER_ACTOR,
    agent,
    approvals,
    github,
    budget,
    // A request made on the web page must reach the Slack approvers too.
    onProposed: async (record, replaced) => void (await slack.sendApprovalCards(record, replaced)),
    mount: (expressApp) =>
      expressApp.use(
        "/mcp",
        createMcpRouter({
          tokens: config.MCP_TOKENS,
          maxFailures: config.AUTH_MAX_FAILURES,
          agent,
          tools: { github, approvals },
          onProposed: async (record, replaced) => void (await slack.sendApprovalCards(record, replaced)),
        }),
      ),
    // A decision made on the web page: tell the Slack user who asked.
    onDecided: async (result) => {
      const requester = result.record?.requestedBy;
      if (requester?.startsWith("slack:")) {
        await slack.send(requester.replace("slack:", ""), `Your request #${result.record?.id.slice(0, 8)}: ${result.text}`);
      }
    },
  });
  let server: Server | undefined;

  return {
    config,
    github,
    approvals,
    budget,
    agent,
    slack,
    async start() {
      // Validates the cron expression first, so a typo stops startup instead of never firing.
      schedule = startDigestSchedule(config.DIGEST_CRON, () => runDigest({ github, send: sendToTeam, runs }));
      await new Promise<void>((resolve, reject) => {
        server = web.listen(config.PORT, () => resolve());
        server.once("error", reject);
      });
      console.log(`Web interface on port ${config.PORT}`);
      await slack.start();
      const recovered = await approvals.recoverInterrupted();
      if (recovered.length > 0) {
        console.log(`Reconciled ${recovered.length} interrupted approval(s) after restart`);
      }
    },
    async stop() {
      schedule?.stop();
      await slack.stop();
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      db.close();
    },
  };
}
