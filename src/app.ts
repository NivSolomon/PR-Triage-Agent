import { Agent } from "./agent/agent.js";
import { OpenAiLlm } from "./agent/llm.js";
import { ApprovalService } from "./approvals/service.js";
import { BudgetService } from "./budget/service.js";
import { TelegramChannel } from "./channels/telegram.js";
import { requireConfig } from "./config.js";
import type { Config } from "./config.js";
import { GitHubClient } from "./github/client.js";
import { runDigest, startDigestSchedule } from "./scheduler/digest.js";
import type { SchedulerHandle } from "./scheduler/digest.js";
import { ActionRepository } from "./store/actions.js";
import { openDatabase } from "./store/db.js";

export interface App {
  config: Config;
  github: GitHubClient;
  approvals: ApprovalService;
  budget: BudgetService;
  agent: Agent;
  telegram: TelegramChannel;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Who may approve. The ONLY definition of approval rights; every channel goes through it. */
export function makeIsApprover(config: Config): (actorId: string) => boolean {
  const telegram = new Set(config.APPROVER_TELEGRAM_IDS.map((id) => `telegram:${id}`));
  return (actorId) => telegram.has(actorId);
}

/** Wire every part together. Fails fast with a clear message if a required secret is missing. */
export function createApp(config: Config): App {
  const env = requireConfig(config, [
    "GITHUB_TOKEN",
    "GITHUB_REPO",
    "LLM_API_KEY",
    "TELEGRAM_BOT_TOKEN",
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
  const approvals = new ApprovalService({
    github,
    repo: new ActionRepository(db),
    isApprover: makeIsApprover(config),
  });

  // Late-bound: the agent needs a way to alert the team, the channel needs the agent.
  let notify: (text: string) => Promise<void> = async () => undefined;
  const agent = new Agent({
    llm: new OpenAiLlm(env.LLM_API_KEY, config.LLM_BASE_URL, config.LLM_MODEL),
    tools: { github, approvals },
    budget,
    notifyTeam: (text) => notify(text),
  });

  const telegram = new TelegramChannel({
    token: env.TELEGRAM_BOT_TOKEN,
    allowedIds: config.TELEGRAM_ALLOWED_USER_IDS,
    approverIds: config.APPROVER_TELEGRAM_IDS,
    agent,
    approvals,
    github,
    budget,
  });
  notify = (text) => telegram.notifyApprovers(text);

  /** Where scheduled messages go: the digest chat if set, otherwise every approver. */
  const sendToTeam = async (text: string): Promise<void> => {
    if (config.TELEGRAM_DIGEST_CHAT_ID) await telegram.send(config.TELEGRAM_DIGEST_CHAT_ID, text);
    else await telegram.notifyApprovers(text);
  };

  let schedule: SchedulerHandle | undefined;

  return {
    config,
    github,
    approvals,
    budget,
    agent,
    telegram,
    async start() {
      // Validates the cron expression first, so a typo stops startup instead of never firing.
      schedule = startDigestSchedule(config.DIGEST_CRON, () => runDigest({ github, send: sendToTeam }));
      await telegram.start();
    },
    async stop() {
      schedule?.stop();
      await telegram.stop();
      db.close();
    },
  };
}
