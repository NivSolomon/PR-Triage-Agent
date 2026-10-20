# PR Triage Agent

An AI agent that helps a small engineering team decide **which pull requests to review first and why**.
It answers only from live GitHub data, explains its reasoning with a confidence level, and can post a
review comment on a pull request **only after a human approves that exact comment**.

> Status: work in progress. See `DECISIONS.md` for the reasoning behind each choice.

## Quick start (local)

```bash
npm install
cp .env.example .env     # then fill in the values
npm run typecheck
npm test
npm run dev
```

Requires Node 22.5+ (uses the built-in `node:sqlite`).

## Project layout

| Path | Purpose |
|---|---|
| `src/config.ts` | Typed, validated environment configuration |
| `test/` | Unit tests (run with `npm test`) |
| `DECISIONS.md` | Design decisions, cost estimate, AI usage log |

## Environment variables

See [`.env.example`](.env.example) for the full list with comments. Secrets are never committed.

## Deployment

_To be completed once the deployment step is done._
