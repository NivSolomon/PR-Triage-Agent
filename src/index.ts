import { loadConfig } from "./config.js";

function main(): void {
  const config = loadConfig();
  console.log(`PR triage agent starting (repo: ${config.GITHUB_REPO ?? "not configured"})`);
}

main();
