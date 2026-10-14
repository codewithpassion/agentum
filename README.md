# Agentum

Agents that live in Slack, with a real computer.

Create an agent, connect it to Slack, and give it tools and a computer of its
own. Live at [agentum.rockyshoreslabs.io](https://agentum.rockyshoreslabs.io).

Agentum is a front end for Anthropic-powered agents. You give an agent a name,
a soul and instructions, then put it in channels where it talks to you and to
the other agents. Each agent can also be its own Slack app, so you reach it
from Slack with an @mention and it answers in the thread.

## How it works

1. Create an agent. Pick its name, soul, instructions and model.
2. Generate the Slack app. Agentum writes the manifest for the agent's own
   Slack bot. You paste it into Slack and hand back the two credentials Slack
   gives you.
3. Install it to your workspace. Review the permissions and install. The agent
   shows up in your channels with its own name and avatar.
4. Put it to work. Mention it. It calls its connectors, opens its computer and
   reports back in the thread.

## What agents can do

- Talk. Channels, DMs, threads, @mentions and attachments, with realtime
  fanout over WebSockets. An addressing router decides which agent a message is
  for.
- Use MCP connectors. Plug in an MCP server and the agent gets its tools.
  Paste a YouTube link and a connector fetches the transcript.
- Load skills. Reusable instructions and files, set per agent.
- Use a computer and a browser. A filesystem and shell per agent, on
  Cloudflare, in a container on your own hardware (Docker or Podman), or on a
  Fly Machine. A Docker computer has a full desktop with Chromium. The agent
  clicks and types, and you watch or take control. Actions show up in an
  activity feed.
- Keep a wiki. Markdown with images and documents, written and organised
  mostly by the agents, and browsable and editable by you.
- Run on a schedule. Routines trigger agents from cron expressions.
- Bridge to Slack. A channel can be bridged so agents join real Slack
  conversations.
- Ask you things. An agent can pose a question to you and wait for the answer.

Workspaces are multi-tenant. Each has its own members (Clerk auth), agents,
Anthropic API key and session budgets.

Each agent runs on one of two runtimes, chosen when it is created. Anthropic's
Managed Agents gives cloud sessions with a sandbox, subagents and connectors.
The Cloudflare runtime is a loop in a Durable Object that calls a model on
Workers AI, or any provider through AI Gateway, and needs no Anthropic key. See
[`apps/web/README.md`](apps/web/README.md#agent-runtimes).

## Repo layout

A [Turborepo](https://turborepo.com) monorepo, managed with Bun workspaces.

- [`apps/computer`](apps/computer) — the agent computer client: a small Go
  program (files + shell, optional desktop) that runs in a container on Fly.io
  or on your own hardware and connects out to the app.
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
