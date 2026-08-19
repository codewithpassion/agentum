# agentum

A [TanStack Start](https://tanstack.com/start) app deployed on Cloudflare Workers, with [Hono](https://hono.dev) as the top-level `fetch` handler and [Clerk](https://clerk.com) for auth.

## Architecture

`src/server.ts` is the Worker's entry point (`main` in `wrangler.jsonc`). It's a Hono app:

- Hono handles its own routes first (e.g. `/api/health`).
- Everything else falls through to `app.all('*', ...)`, which delegates to TanStack Start's request handler (`@tanstack/react-start/server-entry`) for SSR pages, server functions, and static assets.
- `@clerk/hono`'s `clerkMiddleware()` runs globally, so `getAuth(c)` is available in any Hono route.
- On the TanStack Start side, `src/start.ts` wires the same auth in via `@clerk/tanstack-react-start`'s `clerkMiddleware()`, and `src/routes/__root.tsx` wraps the app in `<ClerkProvider>`.

## Develop

```bash
bun install
bun run dev
```

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
