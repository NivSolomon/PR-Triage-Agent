import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// Evals read LLM_* from .env (vitest does not load it on its own).
export default defineConfig({
  test: {
    include: ["evals/**/*.eval.ts"],
    environment: "node",
    env: loadEnv("", process.cwd(), ""),
    testTimeout: 120_000,
    // One at a time: gentler on rate limits and the output reads in order.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
