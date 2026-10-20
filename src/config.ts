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

const jsonMap = z
  .string()
  .default("{}")
  .transform((s, ctx) => {
    try {
      const parsed: unknown = JSON.parse(s);
      return z.record(z.string(), z.enum(["reader", "approver"])).parse(parsed);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: 'must be JSON like {"token":"reader"|"approver"}',
      });
      return z.NEVER;
    }
  });

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_ALLOWED_USER_IDS: csv,
  APPROVER_TELEGRAM_IDS: csv,
  TELEGRAM_DIGEST_CHAT_ID: z.string().optional(),

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
  WEB_ACCESS_KEY: z.string().optional(),
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
  const result = schema.safeParse(env);
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
