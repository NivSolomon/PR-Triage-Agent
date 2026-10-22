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

/** Slack member ids look like U01ABCDEF (or W... on Enterprise Grid). Rejects other kinds of ids, such as plain numbers. */
const slackIds = csv.pipe(z.array(z.string().regex(/^[UW][A-Z0-9]{2,}$/, "must be a Slack member id like U01ABCDEF")));

/** "U01ABCDEF:octocat,U02XYZ123:hubot": which GitHub login each Slack member is (for the personal queue). */
const slackGithubMap = csv
  .pipe(
    z.array(
      z
        .string()
        .regex(/^[UW][A-Z0-9]{2,}:[A-Za-z0-9][A-Za-z0-9-]{0,38}$/, "must look like U01ABCDEF:github-login"),
    ),
  )
  .transform((pairs) => Object.fromEntries(pairs.map((p) => p.split(":") as [string, string])));

/** WEB_USERS: {"dana":{"key":"<16+ chars>","role":"approver"},"lee":{"key":"...","role":"reader"}} */
const webUsers = z
  .string()
  .default("{}")
  .transform((s, ctx) => {
    try {
      const parsed = z
        .record(
          z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/, "name: lowercase letters, digits, . _ - (max 32)"),
          z.object({ key: z.string().min(16, "key too short"), role: z.enum(["reader", "approver"]) }).strict(),
        )
        .parse(JSON.parse(s));
      const users = Object.entries(parsed).map(([name, u]) => ({ name, key: u.key, role: u.role }));
      if (new Set(users.map((u) => u.key)).size !== users.length) throw new Error("duplicate key");
      return users;
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          'must be JSON like {"dana":{"key":"<16+ chars, different for each person>","role":"approver"|"reader"}}; names are lowercase letters, digits, . _ -',
      });
      return z.NEVER;
    }
  });

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
  /** Optional. Links Slack members to GitHub logins so "what should I review" can be personal. */
  SLACK_GITHUB_USERS: slackGithubMap,
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
  /** Recommended web logins: one key per person, each with a role. Actions are recorded under that person's name. */
  WEB_USERS: webUsers,
  /** Set to 1 when behind one reverse proxy (Fly.io), so the real client address and HTTPS are seen. 0 = none. */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
  /** Wrong keys allowed per address in 10 minutes before it is paused. 0 = never pause (fine on a private machine). */
  AUTH_MAX_FAILURES: z.coerce.number().int().min(0).default(10),
  /** Shared key (older, simpler): lets anyone holding it use the web page (read, chat, propose). Cannot approve. */
  WEB_ACCESS_KEY: z.string().min(16, "use at least 16 characters").optional(),
  /** Shared key (older, simpler): lets anyone holding it approve or reject. Must differ from WEB_ACCESS_KEY. */
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
