# DECISIONS

> Living document. Each section is filled in as the matching feature lands, so the
> git history and this file tell the same story.

## 1. The problem, the user, and why an agent

**Who uses it:** a small engineering team (about 5 people) that has a steady flow of open pull requests.

**What it makes easier:** answering "what should we review first, and why?" without opening every PR,
checking CI by hand, and reading review threads.

**Why an agent and not a dashboard:** the useful answer combines several sources (PR metadata, CI check
runs, review state, comments) and needs judgment ("this one blocks others", "this failure looks flaky").
A dashboard can list; it cannot explain, and it cannot draft a comment that a human then approves.

## 2. Assumptions

- One repository per deployment, configured by `GITHUB_REPO`.
- Telegram is the chat channel; a small web page shows the same queue and pending approvals.
- Approvers are a fixed allowlist of Telegram user ids.

## 3. Stack and why

| Choice | Why |
|---|---|
| TypeScript on Node 22 | One language for bot, web, MCP and scheduler; strong typing for tool inputs. |
| `node:sqlite` | Built in, no native build step on Windows or in Docker; enough for pending actions and usage logs. |
| `grammy` | Small, well typed Telegram library with inline buttons for approvals. |
| OpenAI-compatible client | Keeps the model swappable (price/quality) with a base URL and a model name. |
| Official MCP SDK | Standard way to expose tools to other agents. |

## 4. Step-by-step build log

| Step | What | Why |
|---|---|---|
| 1 | Project scaffold, typed config, tests | Fail fast on bad configuration; each feature checks only the secrets it needs. |
| 2 | Read-only GitHub client (`list_open_prs`, `get_pr`) | Grounding starts here: every result carries its `sourceUrl`; PR text is truncated and treated as untrusted; CI that cannot be fetched is reported as unknown (`null`), never as passing; a reviewer's later plain comment does not erase their approval. Uses plain `fetch` + zod instead of Octokit to keep dependencies small and responses validated. |

| 3 | GitHub write methods; SQLite store; approval service | **No approval, no action** is enforced in one place (`ApprovalService`), not in the prompt. The model can only *propose*, which writes a pending row and never calls GitHub. Approving atomically moves `pending -> executing` (`UPDATE ... WHERE status='pending' AND expires_at > now`), so double taps or two approvers cannot post twice. The text posted is read from the stored row, so it is exactly what the approver saw. Approval rights are a fixed allowlist, separate from "who may chat". Proposals expire after 24h and at most 20 can wait at once (flood protection). |

| 4 | Deterministic triage engine (`src/triage`) | **Reasoning is computed, then explained.** Each PR is assessed from named signals (CI, review state, conflicts, age, size) with a weight and the fact it rests on. The model's job later is to explain this output, not to invent a ranking, so the same input gives the same order and the logic is unit-tested. Blocked PRs (red CI, changes requested, conflicts) rank *below* reviewable ones: reviewing them now is wasted effort. Confidence drops when inputs are missing (CI fetch failed = low, CI running or no checks = medium) and the gaps are listed in `unknowns`. The engine never says "flaky": we have no run history, so that would be a guess. One PR failing to load is reported, never silently dropped. |

| 5 | Budget guard and usage log (`src/budget`) | **It never goes over silently.** Every model call is stored with tokens and cost. Three modes (normal / economy / blocked) are decided from real recorded spend, hosting is subtracted first, and a small reserve means one in-flight request cannot push the month over. Each threshold alerts the team once, not on every request. Blocked mode still serves the ranked queue because that needs no model. See section 6 for the numbers. |

| 6 | Agent loop, tools and prompt (`src/agent`) | The model gets three tools: `get_review_queue`, `get_pull_request`, `propose_comment`. There is deliberately **no approve tool**: approving is a human act in the channel. `propose_comment` is hidden from callers who may not propose *and* re-checked inside the executor, so a prompt trick cannot grant it. PR text (descriptions, comments) is returned in a separate `untrustedText` field and the prompt says to treat it as data, never instructions. Tool errors come back as results so the model reports them instead of inventing around them. The loop is capped (4 rounds, 2 in economy mode) and the last round offers no tools, which forces a written answer. Only plain Q&A text is kept as chat history, never tool output, so stale PR data is not replayed as fact. The model sits behind a small `LlmPort`, so tests use a scripted fake and cost nothing. |

| 7 | Telegram channel and composition root (`src/channels`, `src/app.ts`) | Long polling, so no public webhook is needed. Only **private chats from allow-listed ids** are served; everyone else gets their own id back so the owner can add them. **Anyone on the list may ask for a comment, only `APPROVER_TELEGRAM_IDS` may approve** (separate lists; chat access never implies approval). The approval card goes to every approver and is rendered from the stored record, so the approver sees the exact text that will be posted. Buttons are `Approve and post` / `Reject`; after a click the card is edited to show the outcome and the requester is told. Model calls are not awaited inside the update handler: a 20-second answer for one person must not delay anyone else's approval tap. PR titles are sent as plain text (no Markdown mode) so untrusted text cannot inject formatting or links. `/queue` and `/budget` need no model, so they work even when the AI budget is exhausted. |

| 8 | Scheduled digest (`src/scheduler`) | A weekday 08:30 digest (`DIGEST_CRON`) of what to review first, what is ready to merge, and what is stuck on the author. **It is built from the deterministic queue, not the model**: it costs no AI credit, the budget cannot block it, and the same data gives the same text. If the run fails (GitHub down, rate limit) the team gets a "digest could not be built" message instead of silence, because a quiet morning must not be confusable with a broken one. A bad cron expression stops startup. `/digest` runs the same code on demand so a tester can see it without waiting. |

| 9 | Web GUI (`src/web`) | One page served by Express, no build step: chat, the ranked queue, and the approval list with Approve/Reject. **Two keys**: `WEB_ACCESS_KEY` can read, chat and ask for a comment but gets a 403 on approve/reject; `WEB_APPROVER_KEY` can also decide. This gives testers an approval path without needing their Telegram ids, and the approver key is a separate secret from the one used to look around. Keys are compared in constant time, sent as a Bearer header (never in a URL, so they stay out of logs), and 10 wrong keys lock an address out for 10 minutes. The page writes untrusted text with `textContent` only (a test fails if `innerHTML` ever appears), and a CSP blocks inline scripts. A request created on the web is also sent to the Telegram approvers, and a web decision messages the Telegram requester, so the two channels stay in sync. Both go through the same `ApprovalService`, so "posts once" and "text is what was shown" hold on every channel. |

| 10 | MCP endpoint (`src/mcp`) | Stateless Streamable HTTP at `POST /mcp`, bearer-token auth (constant-time compare against every token, wrong-token lockout like the web page). Tools: `get_review_queue`, `get_pull_request`, `ask_triage_agent`, and `propose_comment`. See the answer below. |

### Who may trigger the action through MCP? (requirement 5)

**Nobody can execute it. Only a `proposer` token can start the approval flow.**

| Token role | Can read and ask | Can create a comment *request* | Can approve / post |
|---|---|---|---|
| `reader` | yes | no (tool is not even listed; the executor also refuses) | no |
| `proposer` | yes | yes, recorded as `mcp:proposer:<id>`, shown to the approver | no |
| any MCP token | | | **no: there is no approve tool** |

Why: an MCP client is another program, possibly driven by another model reading untrusted text. If it could approve its own proposal, "human approval" would be decorative. So approval rights live only in `ApprovalService.isApprover`, which accepts Telegram ids from `APPROVER_TELEGRAM_IDS` and the web approver key, and no MCP identity. The MCP role names say what they do (`reader`, `proposer`); an earlier draft called the second one `approver`, which would have promised something the system must never allow, so it was renamed and the config rejects `approver`. `ask_triage_agent` passes the caller's role into the agent (`canPropose`), so a reader cannot get a proposal by asking the model nicely. Each client gets its own actor id (hash of its token, never the token), which is used for the audit trail and the per-client daily cap.

### Failure halfway through an approved action (design, step 3)

Each posted comment carries a hidden marker `<!-- pr-triage-agent:<id> -->`.

- GitHub answered with a 4xx: nothing happened -> `failed`, the user is told nothing was posted and may propose again.
- No response or a 5xx: we **do not guess**. We search the PR's comments for the marker. Found -> `executed` (no duplicate). Lookup works but nothing found -> `failed`. Lookup also fails -> `uncertain`, and the user is told to check the PR before retrying.

### Trade-off: `node:sqlite`

It is still flagged experimental in Node 22 (prints a warning), but it needs no native build, which removes a whole class of Windows/Docker deployment problems. The storage access is behind two small files (`store/db.ts`, `store/actions.ts`), so swapping it for `better-sqlite3` would be a contained change.

## 5. Where AI helped and where it was wrong

_Updated as the project progresses._

## 6. Cost estimate

Assumptions from the brief: 5 people x 20 requests per working day x 22 working days = **2,200 requests/month**.

A request is a short tool loop: the model gets the question plus the tool list (about 1.5k tokens), calls a tool, reads a compact result (the triage queue is pre-digested, about 2-3k tokens), then answers. About 3 model calls per request.

| Item | Tokens per request | Monthly |
|---|---|---|
| Input (typical) | ~8,000 | 17.6M tokens x $0.15/M = **$2.64** |
| Output (typical) | ~800 | 1.76M tokens x $0.60/M = **$1.06** |
| Hosting (small container + 1 GB volume) | - | **$7.00** |
| **Typical total** | | **about $10.70** |

Prices are for `gpt-4o-mini`; they are config (`LLM_PRICE_*`), not code, so changing the model changes the estimate and the guard together.

**Stress case:** 3x the tokens (long PR threads) and 2x the requests (the daily cap allows 40 per person): 6x the typical $3.70 is about $22 of model use + $7 hosting = **about $29**, still under $50. The scheduled digest adds about 22 runs/month, under $0.10.

**What happens near the limit** (`src/budget/service.ts`, tested): the model allowance is `budget - hosting` ($43 by default).

| Spend of allowance | Mode | Behaviour |
|---|---|---|
| under 80% | normal | full behaviour |
| 80% to 100% | economy | fewer tool rounds, shorter answers, the team gets one warning message |
| 100% (or under a $0.10 reserve) | blocked | no model calls; users are told why; `/queue` still works because ranking needs no model; the team gets one alert |

A per-person daily cap (40) stops one user or a looping bot from using the month's budget. Every model call is recorded with its token counts and cost, so the real spend can be compared with this estimate after the first week.

## 7. Understanding questions

_Added at the end._
