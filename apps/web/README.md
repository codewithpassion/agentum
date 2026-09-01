# agentum

A [TanStack Start](https://tanstack.com/start) app deployed on Cloudflare Workers, with [Hono](https://hono.dev) as the top-level `fetch` handler and [Clerk](https://clerk.com) for auth.

## Architecture

`src/server.ts` is the Worker's entry point (`main` in `wrangler.jsonc`). It's a Hono app:

- Hono handles its own routes first (e.g. `/api/health`).
- Everything else falls through to `app.all('*', ...)`, which delegates to TanStack Start's request handler (`@tanstack/react-start/server-entry`) for SSR pages, server functions, and static assets.
- `@clerk/hono`'s `clerkMiddleware()` runs globally, so `getAuth(c)` is available in any Hono route.
- On the TanStack Start side, `src/start.ts` wires the same auth in via `@clerk/tanstack-react-start`'s `clerkMiddleware()`, and `src/routes/__root.tsx` wraps the app in `<ClerkProvider>`.

## Storage

Three bindings, declared in `wrangler.jsonc` and served locally by Miniflare (no
Cloudflare resources are provisioned yet, so `database_id` is a placeholder):

- `DB` — D1. Schema lives in each module's `schema.ts`, wired together by
  `drizzle.config.ts`; `drizzle-kit` writes SQL into `drizzle/`, which is also
  the `migrations_dir` wrangler applies from.
- `ATTACHMENTS` — R2, holding message attachments.
- `CHANNEL_ROOM` — a Durable Object per channel, doing WebSocket fanout for
  `GET /api/channels/:id/ws`. The class is re-exported from `src/server.ts`
  because the runtime needs it on the entry module.
- `AGENT_RUNNER` — a Durable Object per agent on the Cloudflare runtime (see
  below), holding its current session's transcript and running its loop.
- `AI` — Workers AI, and through it AI Gateway. Used only by agents on the
  Cloudflare runtime. Note that the binding calls real models (and bills for
  them) under `bun run dev` too.

## Agent runtimes

Each agent is created on one of two runtimes, fixed for its lifetime:

- **Claude Managed Agents** (`runtime: "managed"`, the default) — the agent is
  registered with Anthropic and every wake runs as a cloud session with the
  sandbox toolset, subagents, connectors and memory store. Needs an Anthropic
  API key (deployment-wide `ANTHROPIC_API_KEY` or a per-workspace key). The
  agent reaches the workspace tools over the MCP endpoint at `/mcp/:token`.
- **Cloudflare** (`runtime: "cloudflare"`) — the agent's loop runs in its own
  `AgentRunner` Durable Object and calls the model through the `AI` binding:
  a Workers AI model (`@cf/moonshotai/kimi-k2.5` is the default) or any
  provider through AI Gateway (`anthropic/claude-sonnet-4-5`,
  `openai/gpt-5.2`, …). The same workspace tools are served to it in-process
  from the same MCP server (`modules/mcp/server.ts`), so the two runtimes can
  never differ in what an agent can do. No Anthropic key is involved. What it
  does not have: Managed Agents subagents, the sandbox toolset, connectors, and
  per-conversation model overrides (`set_model`) — the agent's own model is
  the model.

The router (`modules/router`) drives both through one `SessionGateway`
interface; the Cloudflare runtime's implementation is `modules/runner/gateway.ts`
and its loop is `modules/runner/step.ts`. Per wake, a Cloudflare-runtime agent
may spend at most `MAX_MODEL_CALLS_PER_WAKE` model calls (`modules/runner/config.ts`)
before the session is stopped and the thread told — the equivalent of the
managed runtime's dollar budget.

The two small side decisions that sit in front of an agent - which agent an
unaddressed thread reply was meant for, and Slack's "thinking" line - are
asked of Anthropic Haiku when a key exists and of a small Workers AI model
otherwise (`FAST_WORKERS_AI_MODEL`), so a key-less deployment keeps both.

Set `AI_GATEWAY_ID` to route Workers AI calls through a named AI Gateway
(logging, caching, rate limits); third-party models always go through a
gateway and use `default` when none is named. Provider credentials live on
the gateway (unified billing, or a key stored there), never in this app.

After changing a schema:

```bash
bun run db:generate       # drizzle-kit generate -> drizzle/*.sql
bun run db:migrate:local  # apply to the local D1 that `bun run dev` uses
```

## Develop

```bash
bun install
bun run db:migrate:local  # first run only - creates the local D1 tables
bun run dev
```

Without the migration step the app boots but every `/api` call fails on a
missing table.

Requires Clerk keys in `.env.local` (see `.env.example`): `VITE_CLERK_PUBLISHABLE_KEY` / `CLERK_PUBLISHABLE_KEY` (same value) and `CLERK_SECRET_KEY`. Pull your own with `clerk env pull` after `clerk link --app <app_id>`.

## Build & deploy

`.env.local` only feeds local dev — it's never uploaded. Before the first `wrangler deploy`, set the Clerk keys as real Worker secrets/vars (a deploy without them will 500, the same way local dev did before Clerk keys were added):

```bash
wrangler secret put CLERK_SECRET_KEY
wrangler secret put CLERK_PUBLISHABLE_KEY
wrangler secret put VITE_CLERK_PUBLISHABLE_KEY
```

Then:

```bash
bun run build     # vite build
bun run deploy    # build + wrangler deploy
```

`wrangler.jsonc` has no `account_id` set, so `wrangler deploy`/`wrangler whoami` will use (or prompt for) whichever Cloudflare account is active.

`bun run cf-typegen` regenerates `worker-configuration.d.ts` (the `Env` type) from `wrangler.jsonc` + local env vars — it also runs automatically via `prepare` (`bun install`), so a fresh clone typechecks without a manual step.
