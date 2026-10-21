# PR Triage Agent

An AI agent that helps a small engineering team decide **which pull requests to review first and why**.
It answers only from live GitHub data, explains its reasoning with a confidence level, and can post a
review comment on a pull request **only after a human approves that exact comment**.

Design reasoning, trade-offs, cost estimate, evals and the answers to the understanding questions are in
[`DECISIONS.md`](DECISIONS.md). The architecture diagram is in [`docs/architecture.pdf`](docs/architecture.pdf).

**Live deployment:** https://pr-triage-agent.fly.dev (Fly.io, Frankfurt, one always-on machine with a persistent volume). First deployed 2026-10-21. Health check: [/healthz](https://pr-triage-agent.fly.dev/healthz). Slack is the main channel; the web page asks for a key (shared with testers separately).

## What it does

| Requirement | Where |
|---|---|
| Grounded answers: only from live GitHub data, with source links, says so when it cannot know | `src/github`, `src/agent` |
| Reasoning: ranked queue computed from named facts, plus confidence and unknowns | `src/triage` |
| Action with approval: post a PR comment only after a human approves the exact text | `src/approvals` |
| Channels: Slack app and a web page | `src/channels`, `src/web` |
| MCP: other agents can read, and `proposer` tokens can request (never execute) a comment | `src/mcp` |
| Monthly budget: usage log, economy mode at 80%, hard stop at 100%, per-user daily cap | `src/budget` |
| Scheduled task: weekday morning digest | `src/scheduler` |
| Evals: 12, run against a fixture repo with known answers | `evals/` |

## How a tester uses it

1. **Talk to it:** in Slack, open the **PR Triage Agent** app (Apps in the sidebar) and send `/triage help`, or message it directly. If the deployment is not set to `SLACK_ALLOW_ALL_MEMBERS=true` and you are not on the access list, it replies with your Slack member ID; the owner adds it to `SLACK_ALLOWED_USER_IDS`.
   Or open the deployment URL and sign in with the access key you were given.
2. **Ask:** message the app directly (its **Messages** tab): your questions and its answers stay in the conversation. In a channel, @mention it and it replies in a thread. For quick, private lookups that use no AI credit: `/triage queue`, `/triage digest`, `/triage budget`, `/triage pending` (slash-command replies are private to you and temporary; that is how Slack treats them).
3. **Trigger the approved action:** ask "Leave a comment on #12 asking the author to fix CI". The agent only *proposes*. An approval card with the exact text appears for the approvers.
4. **Who approves, and where:**
   - **Slack approvers** (`SLACK_APPROVER_USER_IDS`) receive the card as a direct message from the app with **Approve and post** (asks "Post this comment?" first) and **Reject** buttons.
   - **Web approver key** (`WEB_APPROVER_KEY`): sign in on the web page with it and use the buttons under **Approvals**. This is how testers can approve without being a Slack approver.
   - The access key and MCP tokens can **never** approve.
5. **MCP:** `POST https://<your-host>/mcp` with `Authorization: Bearer <token>` (Streamable HTTP, stateless). Tools: `get_review_queue`, `get_pull_request`, `ask_triage_agent`, and `propose_comment` for `proposer` tokens only.

## Slack setup (5 minutes, once)

The app uses **Socket Mode**: it opens an outbound connection to Slack, so it needs no public URL, no webhook and no
firewall changes, and it works the same on a laptop and on a server.

1. Go to <https://api.slack.com/apps> -> **Create New App** -> **From a manifest**, pick your workspace, and paste
   [`slack-app-manifest.yaml`](slack-app-manifest.yaml). It sets the scopes, the `/triage` command, the events and
   Socket Mode, so nothing is configured by hand.
2. **Install to Workspace.** Copy the **Bot User OAuth Token** (`xoxb-...`) into `SLACK_BOT_TOKEN`.
3. **Basic Information -> App-Level Tokens -> Generate Token**, scope `connections:write`. Copy it (`xapp-...`) into `SLACK_APP_TOKEN`.
4. Put your own member ID in `SLACK_APPROVER_USER_IDS` (Slack: your profile -> three dots -> **Copy member ID**), and teammates' IDs in `SLACK_ALLOWED_USER_IDS`.
5. Optional: invite the app to a channel (`/invite @PR Triage Agent`) and put the channel ID in `SLACK_DIGEST_CHANNEL_ID` for the morning digest.

Permissions requested (all in the manifest): `commands`, `chat:write`, `chat:write.public`, `app_mentions:read`,
`im:history`, `im:write`. The app cannot read channel history, files or user profiles.
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
| `SLACK_BOT_TOKEN` | yes | Bot token, starts with `xoxb-` (OAuth & Permissions) |
| `SLACK_APP_TOKEN` | yes | App-level token, starts with `xapp-`, scope `connections:write` (Socket Mode) |
| `SLACK_ALLOWED_USER_IDS` | no | Comma-separated Slack member IDs (`U01ABCDEF`) allowed to chat. Empty means only approvers |
| `SLACK_ALLOW_ALL_MEMBERS` | no | `true` lets every member of the workspace chat (for testers), `false` (default) uses only the list above. Never grants approval rights |
| `SLACK_APPROVER_USER_IDS` | yes | Comma-separated member IDs allowed to approve (also allowed to chat) |
| `SLACK_GITHUB_USERS` | no | `U01ABCDEF:octocat,...` links Slack members to GitHub logins, so `/triage queue` and questions like "what should I review?" are personal (review requests for you first, then your own PRs) |
| `SLACK_DIGEST_CHANNEL_ID` | no | Channel ID (`C01ABCDEF`) for the digest; defaults to a DM to every approver |
| `WEB_ACCESS_KEY` | for the web page | 16+ chars. Read, chat, ask for a comment |
| `WEB_APPROVER_KEY` | for web approvals | 16+ chars, different from the access key |
| `MCP_TOKENS` | for MCP | JSON `{"<16+ char token>":"reader"\|"proposer"}` |
| `MONTHLY_BUDGET_USD`, `HOSTING_COST_USD`, `DAILY_REQUESTS_PER_USER` | no | Defaults 50, 7, 40 |
| `DIGEST_CRON`, `TZ` | no | Default `30 8 * * 1-5`, server time zone |
| `PORT`, `DATABASE_PATH` | no | Defaults 3000 and `./data/agent.sqlite` |

Generate strong keys with:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

## Deployment

The app is one container with one SQLite file on a volume. **Run exactly one instance**: the Slack connection
and the scheduler must not run twice, and SQLite is single-writer.

### Fly.io (what `fly.toml` is set up for)

```bash
fly launch --no-deploy --copy-config          # choose a unique app name; keep fly.toml
fly volumes create agent_data --size 1 --region fra
fly secrets set \
  GITHUB_TOKEN=... GITHUB_REPO=owner/repo \
  LLM_API_KEY=... \
  SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... \
  SLACK_ALLOW_ALL_MEMBERS=true SLACK_APPROVER_USER_IDS=U01AAAAAA \
  WEB_ACCESS_KEY=... WEB_APPROVER_KEY=... \
  MCP_TOKENS='{"<token-1>":"reader","<token-2>":"proposer"}'
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
- `/triage help` answers in Slack; `/triage budget` shows the AI budget; `/triage digest` shows the digest.
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
| `src/channels/` | Slack app and shared rendering |
| `src/web/` | Web page and its API |
| `src/mcp/` | MCP endpoint |
| `src/scheduler/` | Morning digest |
| `src/store/` | SQLite access and migrations |
| `test/` | Unit tests (`npm test`) |
| `evals/` | Behaviour evals against a fixture repo (`npm run evals`) |
| `DECISIONS.md` | Decisions, cost estimate, AI usage log, understanding questions |
