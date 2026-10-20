import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = createApp(config);
  await app.start();
  console.log(`PR triage agent running for ${config.GITHUB_REPO}`);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, shutting down`);
    await app.stop().catch((err) => console.error("Error during shutdown:", err));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// A crash here would silently take the bot down, so log it with a non-zero exit for the platform to restart.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
