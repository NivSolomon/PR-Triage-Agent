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
