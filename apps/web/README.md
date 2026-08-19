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
