# PR Triage Agent

An AI agent that helps a small engineering team decide **which pull requests to review first and why**.
It answers only from live GitHub data, explains its reasoning with a confidence level, and can post a
review comment on a pull request **only after a human approves that exact comment**.

Design reasoning, trade-offs, cost estimate, evals and the answers to the understanding questions are in
[`DECISIONS.md`](DECISIONS.md). The architecture diagram is in [`docs/architecture.pdf`](docs/architecture.pdf). Editable Draw.io source: [`docs/architecture.drawio`](docs/architecture.drawio).

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
| Evals: 14, run against a fixture repo with known answers | `evals/` |

## How a tester uses it

1. **Talk to it:** join the Slack workspace (an invite is enough on this deployment). Open the **PR Triage Agent** app (Apps in the sidebar) and send `/triage help`, or message it directly. In a channel, invite the app (`/invite @PR Triage Agent`) and @mention it.
   Or open the deployment URL and sign in with the personal key you were given.
2. **Ask:** message the app directly (its **Messages** tab): your questions and its answers stay in the conversation. In a channel, @mention it and it replies in a thread. For quick, private lookups that use no AI credit: `/triage queue`, `/triage digest`, `/triage budget`, `/triage pending` (slash-command replies are private to you and temporary; that is how Slack treats them).
3. **Trigger the approved action:** ask "Leave a comment on #12 asking the author to fix CI". The agent only *proposes*. An approval card with the exact text appears; nothing is posted to GitHub until a human approves it.
4. **Who approves, and where:**
   - **This deployment (`SLACK_ALLOW_ALL_MEMBERS=true`):** anyone who joined **this** Slack workspace can **Approve and post**, **Edit text** and **Reject** on the card in Slack. The card is sent as a DM to the person who asked, to the named owners (`SLACK_APPROVER_USER_IDS`), and to the team channel (`SLACK_DIGEST_CHANNEL_ID`). `/triage pending` sends you the cards again. A workspace invite is the gate; a Slack Connect guest from another workspace is still refused.
   - **When that flag is off:** only member IDs in `SLACK_APPROVER_USER_IDS` can approve in Slack. Everyone else on `SLACK_ALLOWED_USER_IDS` can still ask for a comment.
   - **Web:** a person in `WEB_USERS` with role `approver` (or the shared `WEB_APPROVER_KEY`) signs in on the web page and uses the buttons under **Approvals**. A `reader` key can look and request, never approve.
   - Reader keys and MCP tokens can **never** approve.
   - **Correcting the wording first:** **Edit text** on the Slack card (the pop-up's button says **Post this comment**) or on the web (**Approve and post edited text**). Submitting the corrected text *is* the approval. The original draft stays on the card and in the history.
5. **MCP:** `POST https://<your-host>/mcp` with `Authorization: Bearer <token>` (Streamable HTTP, stateless). Tools: `get_review_queue`, `get_pull_request`, `ask_triage_agent`, and `propose_comment` for `proposer` tokens only.

**What each person may and may not do** is written in the app itself, and it differs for approvers and everyone else: `/triage help` in Slack, and the **Guide** button in the web page's top bar, which opens it as a popup (it also opens once on a first visit). Both come from one source, `src/guide.ts`, so the two channels cannot say different things.

### The web page

One page with no build step, in light or dark theme (a button in the top bar), using only system fonts and no third-party requests. The product is English-only.

- **Review queue:** summary tiles by state (click one to filter), search, confidence, author and sort filters, "only with warnings" and "hide drafts". Each PR is a card that expands to show a score breakdown (a waterfall from 50 to the final score, one bar per signal with the fact behind it), a confidence meter, and a button that opens the PR on GitHub. **Expand all / Collapse all** is available.
- **Ask the agent:** a side drawer opened by the floating button at the bottom right. It closes with the **Close** button, **Esc**, or a click anywhere outside it. Questions are capped at 2000 characters (the box shows a counter). An idle session that expires does not wipe the chat: sign in again and continue. Answers are laid out as readable sections (the recommendation, then the PRs with their reasons and links), not one block of text.
- **Approvals:** **Pending** and **History** tabs. Pending requests are always listed, even when the history is long. Each request is a collapsible card with a status badge (a rejected request is red, a posted one green), a small flow diagram (Requested, Approval, Posted), and a link button to the posted comment. Approve and Reject each ask for a second click that stays until you confirm or Cancel. A draft that `@`-mentions someone is labelled so the approver knows GitHub will notify them. Approve does nothing if the pull request has already closed. When a request is replaced, rejected or expires, the Slack cards that still showed Approve buttons are updated in place.
- **Scheduled digest:** a read-only panel showing the schedule and its time zone, the next run, where the digest is delivered, whether the last run worked, the last message that was sent, and earlier runs. Each run is recorded in the database, so this survives a restart. It cannot start a run (a run posts to the team channel).
- **Always current, without a hard refresh:** the page script has a version in its address (a deploy changes it, so a new version loads by itself), the page itself is never cached, and `/api` is never cached. The queue is read from GitHub at most once a minute for everyone together (a **Reload** press forces a fresh read, at most once every 10 seconds). When you return to the tab after a few minutes, or stay on it, a stale queue refreshes quietly; the approvals list (local database only) refreshes every 30 seconds while the tab is visible. Sessions are stored in SQLite, so a deploy does not sign everyone out.
- **What each key can do:** a *reader* can look, ask and request a comment, but cannot approve or reject (the server answers 403). An *approver* can also approve, edit and reject. No key can merge, approve, close or edit a pull request on GitHub: the only thing the app ever writes there is one comment, after an approver approves that exact text.

## Slack setup (5 minutes, once)

The app uses **Socket Mode**: it opens an outbound connection to Slack, so it needs no public URL, no webhook and no
firewall changes, and it works the same on a laptop and on a server.

1. Go to <https://api.slack.com/apps> -> **Create New App** -> **From a manifest**, pick your workspace, and paste
   [`slack-app-manifest.yaml`](slack-app-manifest.yaml). It sets the scopes, the `/triage` command, the events and
   Socket Mode, so nothing is configured by hand.
2. **Install to Workspace.** Copy the **Bot User OAuth Token** (`xoxb-...`) into `SLACK_BOT_TOKEN`.
3. **Basic Information -> App-Level Tokens -> Generate Token**, scope `connections:write`. Copy it (`xapp-...`) into `SLACK_APP_TOKEN`.
4. Put your own member ID in `SLACK_APPROVER_USER_IDS` (Slack: your profile -> three dots -> **Copy member ID**). Those people always get a DM of every approval card and the budget alerts. For testers, set `SLACK_ALLOW_ALL_MEMBERS=true` instead of collecting every ID: a workspace invite then lets them chat **and** Approve/Reject in Slack.
5. Invite the app to the channel testers will use (`/invite @PR Triage Agent`) and put that channel ID in `SLACK_DIGEST_CHANNEL_ID` (morning digest, and the approval cards testers click).

Permissions requested (all in the manifest): `commands`, `chat:write`, `chat:write.public`, `app_mentions:read`,
`im:history`, `im:write`, `channels:history`, `groups:history`. Channel history is only used so an edited @mention
is treated as a new question (Slack does not re-send `app_mention` on edit). The app cannot read files or user profiles.
If this app is already installed, paste the updated manifest and **reinstall** so the new scopes apply.

**Guide inside Slack.** Open the app in Slack: the **Home** tab shows a short guide (how to talk to it, example questions, the commands, what nobody can do, how approval works), written from the same source as the web page and /triage help. The **About** tab holds a summary from the manifest's long_description. If you change the manifest later, paste it again under **App Manifest** in the app's settings and reinstall the app.

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
| `GITHUB_TOKEN` | yes | Fine-grained token for one repo: **Issues (read/write)** for comments, **Pull requests (read)**, Contents (read), Checks (read), Metadata (read). Do not grant Pull requests write: this app never merges, closes or edits a PR. |
| `GITHUB_REPO` | yes | `owner/repo` the agent works on |
| `LLM_API_KEY` | yes | Key for any OpenAI-compatible API |
| `LLM_BASE_URL`, `LLM_MODEL` | no | Default OpenAI and `gpt-4o-mini` |
| `LLM_PRICE_INPUT_PER_M`, `LLM_PRICE_OUTPUT_PER_M` | no | USD per 1M tokens; drives the budget guard |
| `SLACK_BOT_TOKEN` | yes | Bot token, starts with `xoxb-` (OAuth & Permissions) |
| `SLACK_APP_TOKEN` | yes | App-level token, starts with `xapp-`, scope `connections:write` (Socket Mode) |
| `SLACK_ALLOWED_USER_IDS` | no | Comma-separated Slack member IDs (`U01ABCDEF`) allowed to chat. Empty means only approvers |
| `SLACK_ALLOW_ALL_MEMBERS` | no | `true` lets every member of **this workspace** chat **and** Approve/Reject in Slack (for testers: a workspace invite is then enough). People from other workspaces in a Slack Connect channel are still refused. `false` (default) uses only the ID lists |
| `SLACK_APPROVER_USER_IDS` | yes | Comma-separated member IDs allowed to approve (also allowed to chat) |
| `SLACK_GITHUB_USERS` | no | `U01ABCDEF:octocat,...` links Slack members to GitHub logins, so `/triage queue` and questions like "what should I review?" are personal (review requests for you first, then your own PRs) |
| `SLACK_DIGEST_CHANNEL_ID` | no | Channel ID (`C01ABCDEF`) for the weekday digest and, when `SLACK_ALLOW_ALL_MEMBERS=true`, the approval cards testers click. Defaults to a DM to every named approver |
| `WEB_USERS` | for the web page (recommended) | JSON `{"dana":{"key":"<16+ chars>","role":"approver","github":"octocat"},"lee":{"key":"<16+ chars>","role":"reader"}}`. One key per person; each key must be different. Optional `github` login groups the web queue like Slack |
| `WEB_ACCESS_KEY`, `WEB_APPROVER_KEY` | no (older alternative) | 16+ chars each, different from each other. Shared by everyone who holds them. Read/chat, and approve, respectively |
| `TRUST_PROXY` | no | Number of reverse proxies in front (`1` on Fly.io, set in `fly.toml`; default `0`). Without it the login lockout cannot tell visitors apart |
| `AUTH_MAX_FAILURES` | no | Wrong keys or tokens allowed per address in 10 minutes before it is paused (web login and MCP). Default `10`. `0` turns the pause off on a private machine (`TRUST_PROXY=0` only); a public host with `TRUST_PROXY` set refuses `0` |
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
  WEB_USERS='{"you":{"key":"<key-1>","role":"approver"},"tester":{"key":"<key-2>","role":"reader"}}' \
  MCP_TOKENS='{"<token-1>":"reader","<token-2>":"proposer"}'
fly deploy
fly status && curl https://<your-app>.fly.dev/healthz
```

Keep it running for the review period: `fly status` should show 1 machine started, and the volume keeps the approvals
and usage history across restarts.

### CI/CD (GitHub Actions)

- `.github/workflows/ci.yml` runs `npm run typecheck` and `npm test` on every pull request and on every push to `main`
  except docs-only ones (`*.md`, `docs/`, `LICENSE`). (`npm run evals` calls the LLM, so it is run by hand.)
- `.github/workflows/deploy.yml` runs `fly deploy` after CI succeeds on `main`, then polls `/healthz`. If the deploy or
  the health check fails, it redeploys the image that was running before. It can also be started by hand from the
  Actions tab. Because it is one machine with a volume, a deploy means a short restart.
- One-time setup: `fly tokens create deploy`, then add the output as the repo secret `FLY_API_TOKEN`
  (GitHub → Settings → Secrets and variables → Actions). Runtime secrets stay in `fly secrets`.
- Recommended: protect `main` (Settings → Branches) and require the `test` check to pass before merging.
- Rollback: `fly releases`, then `fly deploy --image <previous image>`. To test the automatic rollback, run the deploy
  workflow by hand with **simulate_failure** ticked: it deploys, fails the health check on purpose, and must end with
  the previous image running again (about two short restarts).
- Uptime monitoring: an external monitor (for example UptimeRobot, free) pings `/healthz` and emails on failure. It
  also catches a stopped machine or a billing problem, which the pipeline cannot see.

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
