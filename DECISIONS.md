# DECISIONS

Answers the assignment: who it is for, the stack, the required pieces, cost, where AI went wrong, and the three understanding questions.

## 1. Problem, user, why an agent

A small engineering team (~5 people) with a steady flow of open PRs. The question is "what should we review first, and why?" without opening every PR and checking CI by hand.

A dashboard can list. An agent can explain from several sources (metadata, CI, reviews, comments) and draft a comment that a human then approves. Ranking itself is still computed in code, not by the model.

## 2. Assumptions

- One repository per deployment (`GITHUB_REPO`).
- Slack is the live channel (`/triage`, DMs, @mentions). A small web page shows the same queue and approvals. The first version used Telegram; I replaced it because a review team lives in Slack.
- Testers join with a workspace invite. `SLACK_ALLOW_ALL_MEMBERS=true` lets anyone in **this** workspace chat and Approve/Reject. Named owners still get every card as a DM. Slack Connect (another workspace) is refused. MCP tokens and web `reader` keys cannot approve. Off by default; a typo stops startup.
- English only. One instance (Socket Mode + SQLite).

## 3. Stack

| Choice | Why |
|---|---|
| TypeScript on Node 22 | One language for bot, web, MCP and scheduler. |
| `node:sqlite` | Built in, no native build on Windows or Docker. Still experimental in Node 22; storage is two small files if it needs swapping. |
| `@slack/bolt` + Socket Mode | No public webhook. Block Kit gives Approve/Reject with a confirm dialog. |
| OpenAI-compatible client | Model is a URL + name, so price/quality can change without code. |
| Official MCP SDK | Standard way to expose tools to other agents. |

Triage, approvals, budget, agent and scheduler do not import Slack. That is why Telegram → Slack was a channel swap, not a rewrite.

## 4. Required pieces

**Grounding.** Live GitHub only. Every result has a `sourceUrl`. Missing CI is `unknown`, never green. A 404 is `notFound` (no invented URL). PR text is untrusted data, not instructions. Every `#number` in an answer must have been fetched this request, or the user typed it; otherwise a warning is appended and logged.

**Reasoning.** `src/triage` ranks from named signals (CI, reviews, conflicts, wait, size). Same input, same order, unit-tested. The model explains that output; it does not invent the ranking. Blocked PRs sit below reviewable ones. Confidence is "how complete the data was", not "how sure the order is". Score = 50 + a state band + small in-band adjustments (capped so they cannot flip a state). Ready-to-merge needs an approval on the *current* commit, green or no CI, and GitHub `mergeable_state: clean`.

**Action with approval.** Only `ApprovalService` writes to GitHub. The model can only propose (a pending row). Approve claims the row atomically (`pending → executing`), posts the stored text, and never posts twice. Closed/locked PRs fail before the write. MCP has no approve tool; a `proposer` token can only start the flow.

| MCP role | Read / ask | Request a comment | Approve / post |
|---|---|---|---|
| `reader` | yes | no | no |
| `proposer` | yes | yes | no |
| any MCP token | | | **no** |

An approver can edit the wording as part of approving (same atomic claim). A requester or MCP client cannot. Same person asking again on the same PR supersedes the older pending card.

**Channels.** Slack Socket Mode; `/triage` plus DMs and @mentions. Anything that is not a known subcommand is a question. Approval cards show the exact text; Approve asks "Post this comment?". Untrusted Slack markup is escaped (`<!channel>`, disguised links). Web: personal keys (`WEB_USERS`), HttpOnly session cookie, CSRF header; a `reader` cannot approve. Same `ApprovalService` on Slack, web and MCP.

**Budget.** Every model call is logged. Hosting is subtracted first. 80% → economy (shorter, fewer rounds, one warning). 100% or a $0.10 reserve → no model calls; `/triage queue` still works. Per-person daily cap (40). Queue, digest and budget status use no model.

**Scheduled digest.** Sunday–Friday 08:30 Asia/Jerusalem (`DIGEST_CRON=30 8 * * 0-5`). Built from the ranked queue, $0. A failed run tells the team instead of staying silent. Each run is recorded; the web panel is read-only (no "Run now", because that would post to the team channel). `/triage digest` is on demand.

**Evals.** 15 against a frozen repo with known answers (nobody is an approver, so a GitHub write is itself a failure). They check facts and behaviour, not wording. 13 call the model; 11–12 are offline (budget / outage).

| Kind | Examples |
|---|---|
| Grounding | cites real PRs; #999 not invented; weather declined; no diff → says so |
| Reasoning | review-first is #101; failing CI named; unknown CI never called passing |
| Refusal | merge/approve refused; injection in #106 creates nothing; reader cannot propose |
| Approval | wording → one pending request, nothing posted; no wording → nothing created |
| Ops | budget exhausted; model down |

## 5. Where AI helped and where it was wrong

Cursor drafted most of the first code and tests. I reviewed and ran them.

It helped with typed config, GitHub validation, SQLite, and failure cases I would have skipped (double-tap Approve, no GitHub reply, hostile PR text).

It was wrong when:
1. An MCP role was named `approver`. An MCP client must never approve its own proposal. Renamed to `proposer`; config rejects `approver`.
2. The prompt said "plain text"; the model sent Markdown. A prompt is not a guarantee - `toPlainText` in code.
3. The model chose `limit: 5` and silently dropped #106. The system now owns the limit and reports `moreOpenPrsNotShown`.
4. Live, it guessed a change was "an informative comment" and blamed CI on "a test issue" with no diff or logs. The first 12 evals had all passed because none asked a question the data cannot answer about a PR that exists. Prompt + PR tool fixed; evals 13–14 added.
5. Blank `KEY=` in a copied `.env` crashed startup. Tests never used a copied file. Blank now means unset.

**Verified live:** GitHub read, a real comment only after Approve, the model, Slack testers (workspace invite, `/triage`, cards). Slack Connect is unit-tested, not seen on a real shared channel.

## 6. Cost estimate

Brief: 5 people × 20 requests/day × 22 days = **2,200 requests/month**. ~3 model calls per request, `gpt-4o-mini` (`LLM_PRICE_*`).

| Item | Monthly |
|---|---|
| Input ~8k tokens/request | $2.64 |
| Output ~800 tokens/request | $1.06 |
| Hosting (small VM + volume) | $7.00 |
| **Typical** | **~$10.70** |

Stress (3× tokens, 2× requests): ~$29, still under $50. Digest is $0.

Measured on the fixture (`evals/show.ts`): **$0.00047/request** → ~$1.03/month. The table stays higher because the fixture is 6 short PRs; a real repo with long threads sends more. After a week, `/budget` is the real number.

## 7. Understanding questions

**1. The approved action starts and the external API call fails halfway. What happens, and what does the user see?**

The click first claims the row (`pending → executing`) in one update, so a second click cannot run it. Then GitHub is called with a hidden marker `<!-- pr-triage-agent:<id> -->`.

- Closed or locked PR (re-checked before the write): `failed`, nothing posted.
- **4xx:** definitely not posted. `failed`. User sees: approved, but the comment was **not** posted; they can propose again.
- **No reply, 5xx, or a parse error after a 2xx:** I do not guess. I look up the marker. Found → `executed` (no second post). Not found → `failed`. Lookup also fails → `uncertain`. User sees: check the PR before retrying. A new request on that PR is refused until the outcome is known.
- Process dies while `executing`: on the next start the same lookup runs. It never posts again.

I would rather say "I don't know" than risk a duplicate public comment. `test/approvals.test.ts`.

**2. The agent is live for a month. How would I find out it is giving wrong answers before someone relies on them?**

Already in place: a grounding warning on every invented `#number`; evals before each deploy and on a model-name change; deterministic ranking so most of what people act on is not the model; the usage log for a sudden jump in tokens per request.

Not built: a "this was wrong" button, and a weekly sample of five answers vs GitHub.

**3. Which part am I least confident in, and why?**

1. **Scoring weights.** In-band numbers (e.g. +2 for small) are my judgement. They order the fixture well; they have not been measured on this team's PRs.
2. **Evals.** Fact/behaviour checks on one model - a sanity check, not a reliability score.
3. **Slack Connect.** Refusing another workspace is unit-tested. Testers join with an invite, so that path is not on the live tester route, and I have not sat in a real shared channel.
