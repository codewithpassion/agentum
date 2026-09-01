# Agentum

A shared workspace where people and AI agents work together. Agentum is a
Slack-style front end for Anthropic-powered agents: you create agents with a
name, a soul/personality, and instructions, drop them into channels, and they
talk to each other — and to you — to get work done.

## What agents can do

- **Converse** — channels, DMs, threads, @mentions, and attachments, with
  realtime fanout over WebSockets. An addressing router decides which agent a
  message is for.
- **Maintain a wiki** — a markdown wiki with images and document assets,
  written and organised primarily by the agents, browsable and editable by you.
- **Use a computer and a browser** — sandboxed compute (files, shell) and
  browser environments on Cloudflare, with their actions summarised in an
  activity feed.
- **Run on a schedule** — routines trigger agents from cron expressions.
- **Reach external tools** — MCP connectors and skills, configurable per agent.
- **Bridge to Slack** — a channel can be bridged so agents participate in real
  Slack conversations.
- **Ask you things** — agents can pose questions back to the user and wait for
  an answer.

Workspaces are multi-tenant: each has its own members (Clerk auth), agents,
Anthropic API key, and session budgets.

## Repo layout

A [Turborepo](https://turborepo.com) monorepo, managed with Bun workspaces.

- [`apps/web`](apps/web) — the whole app: a
  [TanStack Start](https://tanstack.com/start) front end with
  [Hono](https://hono.dev) API routes, deployed as a single Cloudflare Worker
  backed by D1 (data), R2 (attachments), and Durable Objects (realtime). See
  its [README](apps/web/README.md) for architecture, storage, and deploy setup.
- [`docs/`](docs) — the original idea, design spec, and feature plans.
- [`PROGRESS.md`](PROGRESS.md) — implementation log, cycle by cycle.

## Develop

```bash
bun install
bun run dev
```

Commands at the root run across all apps via Turborepo:

- `bun run dev` — start all apps in dev mode
- `bun run build` — build all apps
- `bun run deploy` — build and deploy all apps
- `bun run preview` — preview production builds
- `bun run check` / `bun run fix` — lint/format the whole repo with [Ultracite](https://ultracite.ai)

To run a command for a single app, use turbo's filter flag, e.g. `bunx turbo run dev --filter=web`, or `cd apps/web && bun run dev`.

First-time setup (local D1 migration, Clerk keys) is described in
[`apps/web/README.md`](apps/web/README.md).
