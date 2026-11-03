# Agentum

A [TanStack Start](https://tanstack.com/start) app deployed on Cloudflare Workers, with [Hono](https://hono.dev) as the top-level `fetch` handler and [Cloudflare D1](https://developers.cloudflare.com/d1/) for data.

Auth is [Clerk](https://clerk.com): `/login` signs in, the header shows the
signed-in user. A Clerk organisation gets in when a `workspaces` row has its id,
and `bun run add-workspace --org <id> --name <name> (--local | --remote [--env staging])`
makes the first one of a deployment. It checks the organisation exists on the
Clerk instance for that environment: `--local` and `--env staging` use the key in
`.env.local`, plain `--remote` uses the one in `.env.production.local` or the
process environment.

## Architecture

`src/server.ts` is the Worker's entry point (`main` in `wrangler.jsonc`). It's a Hono app:

- Hono handles its own routes first (e.g. `/api/health`).
- `/api/trpc/*` is the [tRPC](https://trpc.io) API, mounted with `@hono/trpc-server`.
- Everything else falls through to `app.all('*', ...)`, which delegates to TanStack Start's request handler (`@tanstack/react-start/server-entry`) for SSR pages and static assets.

## tRPC

`src/server/trpc/` holds the API:

- `context.ts` builds `ctx` for each call: the services from [`@repo/services`](../../packages/services) on this request's `drizzle(env.DB)`, and `principal`, the signed-in user in their workspace, or null. The principal comes from the Clerk session (`getAuth(c)` over HTTP, `auth()` during SSR): its active organisation must have a `workspaces` row, and no request makes one. `build-context.ts` holds the part that has no Clerk or Worker imports, so tests can build a `ctx` from a fake session.
- `init.ts` defines `publicProcedure` (anyone) and `workspaceProcedure` (a user whose active organisation has a workspace row, 401 otherwise; narrows `ctx.principal` to the user principal).
- `router.ts` is the app router: `me` (returns `{ userId, workspaceId }`, the example).
- `routers/<name>.ts` holds one router per area. Keep them thin: an input schema from the service, then one service call.

`src/integrations/trpc/client.ts` exports `getTrpc()`. In the browser it is an HTTP client for `/api/trpc`. During SSR it runs the router in-process (`unstable_localLink`), so loaders do not fetch their own Worker. Call it from loaders and event handlers, for example `getTrpc().<router>.<procedure>.query()`.

## D1

Database access goes through the workspace package [`@repo/db`](../../packages/db) (see its README for the schema, the migrations and the test setup). In this app:

- `wrangler.jsonc` declares the `d1_databases` binding named `DB`, with `migrations_dir` pointing at `packages/db/migrations`. `bun run cf-typegen` turns that into `env.DB: D1Database`.
- `src/server/trpc/context.ts` calls `drizzle(env.DB)` from `drizzle-orm/d1` and hands it to the services. That is the one place the binding is read.
- The app has no database page right now. TODO(M0): health check
- Browser code imports only `@repo/db/shared`. The other entries import drizzle and belong behind tRPC.

`bun run dev` runs `wrangler d1 migrations apply DB --local` before starting Vite, so the local database that Miniflare serves is always up to date. It lives in `.wrangler`, which is gitignored; delete that folder for a clean slate.

## Develop

```bash
bun install
bun run dev
```

The database needs no configuration for local work.

### Sign in on a deployed environment

`bun run agent-login --env staging` prints a one-time Clerk Agent Task URL that
signs the dev user in without the sign-in screen. Open it in a fresh browser
session. Other flags: `--env local|staging|preview|production`, `--pr <n>` for
preview, `--email`, `--redirect <path>`, `--base-url`. Local, staging and
preview read `CLERK_SECRET_KEY` from `.env.local`. Production reads it from
`.env.production.local` or the process environment. Treat the URL as a
password. Local development also has the one-click dev login on `/login`.

## Build & deploy

The local database only exists on your machine, so the deployed Worker needs a real D1 database. Create one, put the id it prints into `d1_databases[0].database_id` in `wrangler.jsonc`, and create the tables:

```bash
bunx wrangler d1 create boilerplate
bunx wrangler d1 migrations apply DB --remote
```

Then:

```bash
bun run build     # vite build
bun run deploy    # build + wrangler deploy
```

`wrangler.jsonc` has no `account_id` set, so `wrangler deploy`/`wrangler whoami` will use (or prompt for) whichever Cloudflare account is active.

`bun run cf-typegen` regenerates `worker-configuration.d.ts` (the `Env` type) from `wrangler.jsonc` + local env vars — it also runs automatically via `prepare` (`bun install`), so a fresh clone typechecks without a manual step.
