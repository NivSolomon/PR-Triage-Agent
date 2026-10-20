# PR Triage Agent

An AI agent that helps a small engineering team decide **which pull requests to review first and why**.
It answers only from live GitHub data, explains its reasoning with a confidence level, and can post a
review comment on a pull request **only after a human approves that exact comment**.

Design reasoning, trade-offs, cost estimate, evals and the answers to the understanding questions are in
[`DECISIONS.md`](DECISIONS.md). The architecture diagram is in [`docs/architecture.pdf`](docs/architecture.pdf).

## What it does

| Requirement | Where |
|---|---|
| Grounded answers: only from live GitHub data, with source links, says so when it cannot know | `src/github`, `src/agent` |
| Reasoning: ranked queue computed from named facts, plus confidence and unknowns | `src/triage` |
| Action with approval: post a PR comment only after a human approves the exact text | `src/approvals` |
| Channels: Telegram bot and a web page | `src/channels`, `src/web` |
| MCP: other agents can read, and `proposer` tokens can request (never execute) a comment | `src/mcp` |
| Monthly budget: usage log, economy mode at 80%, hard stop at 100%, per-user daily cap | `src/budget` |
| Scheduled task: weekday morning digest | `src/scheduler` |
| Evals: 12, run against a fixture repo with known answers | `evals/` |

## How a tester uses it

1. **Talk to it:** open the Telegram bot link you were sent and send `/start`. If you are not on the access list it replies with your Telegram id; the owner adds it to `TELEGRAM_ALLOWED_USER_IDS`.
   Or open the deployment URL and sign in with the access key you were given.
2. **Ask:** "What should we review first?", "Why is #12 blocked?", or `/queue`, `/digest`, `/budget`.
3. **Trigger the approved action:** ask "Leave a comment on #12 asking the author to fix CI". The agent only *proposes*. An approval card with the exact text appears for the approvers.
4. **Who approves, and where:**
   - **Telegram approvers** (`APPROVER_TELEGRAM_IDS`) receive the card in a private chat with **Approve and post** / **Reject** buttons.
   - **Web approver key** (`WEB_APPROVER_KEY`): sign in on the web page with it and use the buttons under **Approvals**. This is how testers can approve without a Telegram id.
   - The access key and MCP tokens can **never** approve.
5. **MCP:** `POST {PUBLIC_BASE_URL}/mcp` with `Authorization: Bearer <token>` (Streamable HTTP, stateless). Tools: `get_review_queue`, `get_pull_request`, `ask_triage_agent`, and `propose_comment` for `proposer` tokens only.

## Local development

```bash
npm install
cp .env.example .env     # fill in the values (the file is git-ignored)
npm run typecheck
npm test                 # unit tests, no network, no API cost
npm run evals            # behaviour evals; needs LLM_API_KEY, costs a few cents
npm run dev
```

Requires Node 22.5+ (uses the built-in `node:sqlite`).

## Environment variables

Secrets are **never committed**. Locally they live in `.env` (git-ignored); in production they are platform secrets.
[`.env.example`](.env.example) has every variable with comments.

| Variable | Required | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | yes | Fine-grained token for one repo: Pull requests (r/w), Issues (r/w), Contents (read), Metadata (read) |
| `GITHUB_REPO` | yes | `owner/repo` the agent works on |
| `LLM_API_KEY` | yes | Key for any OpenAI-compatible API |
| `LLM_BASE_URL`, `LLM_MODEL` | no | Default OpenAI and `gpt-4o-mini` |
| `LLM_PRICE_INPUT_PER_M`, `LLM_PRICE_OUTPUT_PER_M` | no | USD per 1M tokens; drives the budget guard |
| `TELEGRAM_BOT_TOKEN` | yes | From @BotFather |
| `TELEGRAM_ALLOWED_USER_IDS` | yes | Comma-separated ids allowed to chat |
| `APPROVER_TELEGRAM_IDS` | yes | Comma-separated ids allowed to approve (also allowed to chat) |
| `TELEGRAM_DIGEST_CHAT_ID` | no | Where the digest goes; defaults to every approver |
| `WEB_ACCESS_KEY` | for the web page | 16+ chars. Read, chat, ask for a comment |
| `WEB_APPROVER_KEY` | for web approvals | 16+ chars, different from the access key |
| `MCP_TOKENS` | for MCP | JSON `{"<16+ char token>":"reader"\|"proposer"}` |
| `MONTHLY_BUDGET_USD`, `HOSTING_COST_USD`, `DAILY_REQUESTS_PER_USER` | no | Defaults 50, 7, 40 |
| `DIGEST_CRON`, `TZ` | no | Default `30 8 * * 1-5`, server time zone |
| `PORT`, `PUBLIC_BASE_URL`, `DATABASE_PATH` | no | Defaults 3000, localhost, `./data/agent.sqlite` |

Generate strong keys with:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

## Deployment

The app is one container with one SQLite file on a volume. **Run exactly one instance**: Telegram long polling and
the scheduler must not run twice, and SQLite is single-writer.

### Fly.io (what `fly.toml` is set up for)

```bash
fly launch --no-deploy --copy-config          # choose a unique app name; keep fly.toml
fly volumes create agent_data --size 1 --region fra
fly secrets set \
  GITHUB_TOKEN=... GITHUB_REPO=owner/repo \
  LLM_API_KEY=... \
  TELEGRAM_BOT_TOKEN=... TELEGRAM_ALLOWED_USER_IDS=111,222 APPROVER_TELEGRAM_IDS=111 \
  WEB_ACCESS_KEY=... WEB_APPROVER_KEY=... \
  MCP_TOKENS='{"<token-1>":"reader","<token-2>":"proposer"}' \
  PUBLIC_BASE_URL=https://<your-app>.fly.dev
fly deploy
fly status && curl https://<your-app>.fly.dev/healthz
```

Keep it running for the review period: `fly status` should show 1 machine started, and the volume keeps the approvals
and usage history across restarts.

### Any Docker host

```bash
docker build -t pr-triage-agent .
docker run -d --name pr-triage --restart unless-stopped \
  --env-file .env -p 3000:3000 -v pr_triage_data:/data pr-triage-agent
```

### After deploying, check

- `GET /healthz` returns `{"ok":true}`.
- `/start` to the bot answers; `/budget` shows the AI budget; `/digest` shows the digest.
- A proposed comment shows an approval card, and nothing appears on the PR until it is approved.

## Project layout

| Path | Purpose |
|---|---|
| `src/config.ts` | Typed, validated environment configuration |
| `src/github/` | Read-only client plus the one write (comment), with timeouts and error mapping |
| `src/triage/` | Deterministic assessment and ranking of PRs |
| `src/approvals/` | The approval gate: propose, approve, reject, failure handling |
| `src/agent/` | Model loop, tools, prompt, permissions |
| `src/budget/` | Usage log and monthly budget guard |
| `src/channels/` | Telegram bot and shared rendering |
| `src/web/` | Web page and its API |
| `src/mcp/` | MCP endpoint |
| `src/scheduler/` | Morning digest |
| `src/store/` | SQLite access and migrations |
| `test/` | Unit tests (`npm test`) |
| `evals/` | Behaviour evals against a fixture repo (`npm run evals`) |
| `DECISIONS.md` | Decisions, cost estimate, AI usage log, understanding questions |
