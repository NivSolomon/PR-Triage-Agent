# PR Triage Agent

Ranks open pull requests by **what to review first and why**, from live GitHub data.
It can draft a public comment; **nothing is posted until a human approves that exact text**.

**Live:** https://pr-triage-agent.fly.dev ([/healthz](https://pr-triage-agent.fly.dev/healthz)). Slack is the main channel; the web page uses a personal access key.

Design, cost, evals and trade-offs: [`DECISIONS.md`](DECISIONS.md). Architecture: [`docs/architecture.pdf`](docs/architecture.pdf).

## How to try it

1. **Slack:** open the **PR Triage Agent** app → `/triage help`, or message it. In a channel: `/invite @PR Triage Agent`, then @mention it.
   **Web:** open the URL and sign in with the key you were given.
2. **Ask** what to review first, what is blocked, or what is ready to merge. Slack Home, `/triage help`, and the web chips share the same example questions.
   No AI credit: `/triage queue`, `/triage digest`, `/triage budget`, `/triage pending` (slash-command replies are private and temporary).
3. **A comment:** `Leave a comment on #12 asking the author to fix CI`. The agent only proposes. An approval card (or the web **Approvals** panel) shows the exact text; GitHub is unchanged until someone approves it.
4. **Who can approve on this deployment:** anyone in **this** Slack workspace (`SLACK_ALLOW_ALL_MEMBERS=true`). The card is a DM, and also the digest channel. On the web, an `approver` key can decide; a `reader` key cannot. Nobody can merge, close, approve or edit a pull request on GitHub.

`/triage help` and the web **Guide** list what each role can and cannot do.

## What testers see

**Slack:** `/triage`, DMs, and @mentions. Home is a short guide (same rules as the web Guide).

**Web:** one page - ranked queue (state tiles, search, score breakdown), a chat drawer, pending/history approvals, and digest status. Light/dark theme. English only.

## Slack setup (once)

Socket Mode: outbound connection, no public webhook.

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest** → paste [`slack-app-manifest.yaml`](slack-app-manifest.yaml).
2. **Install to Workspace.** Bot token (`xoxb-…`) → `SLACK_BOT_TOKEN`.
3. **App-Level Tokens** → scope `connections:write` (`xapp-…`) → `SLACK_APP_TOKEN`.
4. Your member ID → `SLACK_APPROVER_USER_IDS` (profile → three dots → **Copy member ID**). For testers, also set `SLACK_ALLOW_ALL_MEMBERS=true`.
5. `/invite @PR Triage Agent` in the channel testers use, and put that channel ID in `SLACK_DIGEST_CHANNEL_ID`.

If the app is already installed, paste the updated manifest and **reinstall**. Channel history scopes (`channels:history`, `groups:history`) exist only so an edited @mention is treated as a new question.

## Local development

Needs Node 22.5+ (built-in `node:sqlite`).

1. Install dependencies: `npm install`
2. Copy [`.env.example`](.env.example) to `.env` (git-ignored) and fill in the values.
3. Check types: `npm run typecheck`
4. Run unit tests (no network, no API cost): `npm test`
5. Optional - behaviour evals (needs `LLM_API_KEY`, a few cents): `npm run evals`
6. Optional - prompt bank against the fixture agent: `npm run prompts`
7. Start the app: `npm run dev`

## Environment

Secrets are never committed. Locally they live in `.env`; in production they are platform secrets.
[`.env.example`](.env.example) documents every variable.

| Variable | Required | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | yes | Fine-grained: Issues (read/write) for comments, Pull requests / Contents / Checks / Metadata (read). No Pull requests write. |
| `GITHUB_REPO` | yes | `owner/repo` |
| `LLM_API_KEY` | yes | Any OpenAI-compatible API |
| `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | yes | `xoxb-` and `xapp-` (`connections:write`) |
| `SLACK_APPROVER_USER_IDS` | yes | Slack member IDs that may approve (and always chat) |
| `SLACK_ALLOW_ALL_MEMBERS` | no | `true` = every member of this workspace may chat and approve (testers) |
| `SLACK_ALLOWED_USER_IDS` | no | Extra chat allow-list when the flag above is off |
| `SLACK_GITHUB_USERS` | no | `U01ABCDEF:octocat,…` so the queue can be personal |
| `SLACK_DIGEST_CHANNEL_ID` | no | Digest (and tester approval cards). Default: DM every named approver |
| `WEB_USERS` | for the web page | `{"dana":{"key":"<16+ chars>","role":"approver","github":"octocat"}}` |
| `WEB_ACCESS_KEY`, `WEB_APPROVER_KEY` | no | Older shared keys (read / approve) |
| `MCP_TOKENS` | for MCP | `{"<16+ char token>":"reader"\|"proposer"}`. No MCP role can approve. |
| `TRUST_PROXY` | no | `1` on Fly, `0` locally |
| `AUTH_MAX_FAILURES` | no | Wrong keys per address / 10 minutes. Default `10`. `0` only when `TRUST_PROXY=0` |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_PRICE_*` | no | Default OpenAI + `gpt-4o-mini`; prices drive the budget |
| `MONTHLY_BUDGET_USD`, `HOSTING_COST_USD`, `DAILY_REQUESTS_PER_USER` | no | Defaults 50, 7, 40 |
| `DIGEST_CRON`, `TZ` | no | Default `30 8 * * 0-5` (08:30 Sun–Fri), `Asia/Jerusalem` |
| `PORT`, `DATABASE_PATH` | no | Defaults 3000 and `./data/agent.sqlite` |

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

## Deployment

One container, one SQLite volume, **one instance** - Slack and the scheduler must not run twice.

### First time on Fly.io

1. Create the app from this repo’s `fly.toml` (do not deploy yet):
   `fly launch --no-deploy --copy-config`
2. Create a 1 GB volume in `fra` for the SQLite file:
   `fly volumes create agent_data --size 1 --region fra`
3. Set runtime secrets (never put these in `fly.toml`). Generate web/MCP keys with the command in [Environment](#environment).

   ```bash
   fly secrets set \
     GITHUB_TOKEN=... GITHUB_REPO=owner/repo \
     LLM_API_KEY=... \
     SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... \
     SLACK_ALLOW_ALL_MEMBERS=true SLACK_APPROVER_USER_IDS=U01AAAAAA \
     WEB_USERS='{"you":{"key":"<key-1>","role":"approver"},"tester":{"key":"<key-2>","role":"reader"}}' \
     MCP_TOKENS='{"<token-1>":"reader","<token-2>":"proposer"}'
   ```

4. Deploy: `fly deploy`
5. Confirm the machine is up: `fly status`
6. Confirm the health check: `curl https://<your-app>.fly.dev/healthz` - expect `{"ok":true}`

Later deploys are just step 4 (`fly deploy`), or a push to `main` once CI/CD is connected.

### After it is up

1. In Slack, `/triage help` answers and `/triage budget` shows the AI budget.
2. Ask for a comment on a PR: an approval card appears, and nothing is on GitHub yet.
3. Approve the card: the comment appears on the pull request.

### Later: deploy from GitHub Actions

1. Create a deploy token: `fly tokens create deploy`
2. Add it as the repo secret `FLY_API_TOKEN` (GitHub → Settings → Secrets → Actions). Runtime secrets stay in `fly secrets`.
3. Push to `main`. `.github/workflows/ci.yml` typechecks and tests; if that passes, `deploy.yml` runs `fly deploy` and rolls back if `/healthz` fails.

Evals are not in CI (`npm run evals` costs money). Run them by hand.

## Layout

| Path | Purpose |
|---|---|
| `src/triage/` | Ranked queue from named facts |
| `src/agent/` | Model loop, tools, prompt |
| `src/approvals/` | Propose / approve / reject (the only GitHub write) |
| `src/github/` | GitHub client |
| `src/channels/`, `src/web/`, `src/mcp/` | Slack, web page, MCP |
| `src/budget/`, `src/scheduler/`, `src/store/` | Budget, weekday digest, SQLite |
| `test/`, `evals/` | Unit tests; behaviour evals on a frozen fixture |
| `DECISIONS.md` | Why, cost, understanding questions |
