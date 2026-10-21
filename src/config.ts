import { z } from "zod";

const csv = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );

/** Slack member ids look like U01ABCDEF (or W... on Enterprise Grid). Rejects leftover numeric Telegram ids. */
const slackIds = csv.pipe(z.array(z.string().regex(/^[UW][A-Z0-9]{2,}$/, "must be a Slack member id like U01ABCDEF")));

const jsonMap = z
  .string()
  .default("{}")
  .transform((s, ctx) => {
    try {
      const parsed: unknown = JSON.parse(s);
      // Roles: "reader" = read + ask; "proposer" = also create (never execute) comment requests.
      // There is deliberately no MCP role that can approve: approval is a human act.
      return z
        .record(z.string().min(16, "token too short"), z.enum(["reader", "proposer"]))
        .parse(parsed);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: 'must be JSON like {"<token of 16+ chars>":"reader"|"proposer"}',
      });
      return z.NEVER;
    }
  });

const schema = z.object({
  /** Bot token (xoxb-...): lets the app post messages. */
  SLACK_BOT_TOKEN: z.string().startsWith("xoxb-", "must be a bot token starting with xoxb-").optional(),
  /** App-level token (xapp-...) with connections:write: opens the Socket Mode connection. */
  SLACK_APP_TOKEN: z.string().startsWith("xapp-", "must be an app-level token starting with xapp-").optional(),
  /** Slack member ids allowed to chat with the bot. Approvers are always allowed too. */
  SLACK_ALLOWED_USER_IDS: slackIds,
  /** "true": every member of the Slack workspace may chat. Approving still needs SLACK_APPROVER_USER_IDS. */
  SLACK_ALLOW_ALL_MEMBERS: z
    .enum(["true", "false"], { error: 'must be "true" or "false"' })
    .default("false")
    .transform((v) => v === "true"),
  /** Slack member ids allowed to approve or reject. */
  SLACK_APPROVER_USER_IDS: slackIds,
  /** Channel id (C...) for the scheduled digest. If unset, the digest is sent to each approver as a DM. */
  SLACK_DIGEST_CHANNEL_ID: z.string().regex(/^[CG][A-Z0-9]{2,}$/, "must be a Slack channel id like C01ABCDEF").optional(),

  GITHUB_TOKEN: z.string().optional(),
  GITHUB_REPO: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, "must look like owner/repo")
    .optional(),

  LLM_API_KEY: z.string().optional(),
  LLM_BASE_URL: z.string().default("https://api.openai.com/v1"),
  LLM_MODEL: z.string().default("gpt-4o-mini"),
  LLM_PRICE_INPUT_PER_M: z.coerce.number().nonnegative().default(0.15),
  LLM_PRICE_OUTPUT_PER_M: z.coerce.number().nonnegative().default(0.6),

  MONTHLY_BUDGET_USD: z.coerce.number().positive().default(50),
  HOSTING_COST_USD: z.coerce.number().nonnegative().default(7),
  /** Per person per day. The brief assumes ~20 uses, so 40 leaves headroom without inviting abuse. */
  DAILY_REQUESTS_PER_USER: z.coerce.number().int().positive().default(40),

  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().default("http://localhost:3000"),
  /** Lets someone use the web page (read, chat, propose). Cannot approve. */
  WEB_ACCESS_KEY: z.string().min(16, "use at least 16 characters").optional(),
  /** Lets someone approve or reject from the web page. Must differ from WEB_ACCESS_KEY. */
  WEB_APPROVER_KEY: z.string().min(16, "use at least 16 characters").optional(),
  MCP_TOKENS: jsonMap,

  DIGEST_CRON: z.string().default("30 8 * * 1-5"),

  DATABASE_PATH: z.string().default("./data/agent.sqlite"),
});

export type Config = z.infer<typeof schema>;

/**
 * Parse and validate configuration from environment variables.
 * Secrets are optional here on purpose: each feature checks the ones it needs
 * via `requireConfig`, so the app (and the tests) can run with partial config.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // A line like `WEB_ACCESS_KEY=` (as copied from .env.example) arrives as "". That means "not set",
  // not "set to an invalid empty value", so drop blanks before validating.
  const present = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""),
  );
  const result = schema.safeParse(present);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${details}`);
  }
  return result.data;
}

/** Return the given keys as non-optional, or throw a clear error naming what is missing. */
export function requireConfig<K extends keyof Config>(
  config: Config,
  keys: readonly K[],
): { [P in K]-?: NonNullable<Config[P]> } {
  const missing = keys.filter((k) => {
    const v = config[k];
    return v === undefined || v === null || v === "";
  });
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
  // Safe: every requested key was verified non-empty above.
  return config as unknown as { [P in K]-?: NonNullable<Config[P]> };
}
