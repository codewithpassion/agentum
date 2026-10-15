
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## shadcn components

`apps/web/src/components/ui/`, `lib/utils.ts` and `hooks/use-mobile.ts` are shadcn CLI
output. Never hand-edit them, and put nothing else in `components/ui/`. `biome.jsonc`
excludes them at the `files` level because `ultracite fix` corrupts them. See
`apps/web/src/components/ui/CLAUDE.md`.

## Database (D1 + Drizzle)

Data access lives in `packages/db` (`@repo/db`), see its README. Rules that
are easy to break:

- Only `packages/services` imports `@repo/db/notes` and the other table
  modules; the app goes through the services (below). Anything a React
  component needs comes from `@repo/db/shared`. The other entries pull drizzle into the
  browser bundle. One entry per module in `exports`, no barrel file.
- Query functions take a drizzle instance, they never make one. The app passes
  `drizzle(env.DB)` from `drizzle-orm/d1`; the tests pass a `bun:sqlite` one. The
  parameter type is `Database` from `@repo/db`, which covers both.
- Changing `src/schema.ts` means running `bun run generate` in `packages/db` and
  committing `migrations/` including `migrations/meta/`.
- Migrations are applied by wrangler, not drizzle-kit: `wrangler d1 migrations
  apply DB --local` (which `bun run dev` does for you) or `--remote`.
- Local database: SQLite via Miniflare, in `apps/web/.wrangler`. No account, no
  Docker. Delete that folder for a clean slate.

## Services and tRPC

Business logic lives in `packages/services` (`@repo/services`), see its README.
The app reaches it only through tRPC, mounted in Hono at `/api/trpc`. Rules
that are easy to break:

- Layers: route component -> tRPC router (`apps/web/src/server/trpc/`) ->
  service (`@repo/services/<module>`) -> query functions (`@repo/db/<module>`).
  Routers stay thin: input schema plus one service call. Validation and rules
  go in the service, which takes a `Database` and never reads `env`.
- No `createServerFn`. Route loaders and components call
  `getTrpc()` from `#/integrations/trpc/client`. It calls the router in-process
  during SSR and over HTTP in the browser, so it works in both.
- Two procedure kinds in `init.ts`: `publicProcedure` for anyone,
  `protectedProcedure` for signed-in users (narrows `ctx.userId` to a string).
  `context.ts` reads the Clerk session, so `ctx.userId` is the signed-in user
  or null.
- A new service goes in the context in `context.ts`, and add-clerk keeps a copy
  of that file in `.claude/skills/add-clerk/templates/apps/web/src/server/trpc/`.
  Change both, or running add-clerk later drops the new service.
- Server code (`#/server/**`, drizzle, `cloudflare:workers`) must not reach the
  browser bundle. After touching the client, `bun run build` and grep
  `apps/web/dist/client` for `drizzle` to check.

## Starting a new project

A copy of this boilerplate becomes a project through `/project-init`. The user
has to type it, because the skill sets `disable-model-invocation`. It calls
`rename-project`, then `add-clerk` if the user wants auth, then
`setup-cloudflare` for the D1 database and the first deploy. When a user asks
how to start or deploy a fresh copy, point them to `/project-init` and don't
redo its steps by hand. PR previews come afterwards, from `setup-previews`.
README.md "Start a new project" has the steps for users.

Signs a copy has not been initialised: the workspace is still named
`boilerplate` in `package.json`, and `database_id` in `apps/web/wrangler.jsonc`
is still `"local"`.

## Deploy

Local dev needs no accounts. Deploying needs a Cloudflare account (`bunx wrangler
login`) and a D1 database (`wrangler d1 create <name>`, its id into `d1_databases`
in `apps/web/wrangler.jsonc`). Before the first `bun run deploy`, run `wrangler d1
migrations apply DB --remote` once. Full steps: README.md "Deploy".

## Pull request previews

`.github/workflows/preview.yml` deploys every PR as a preview of the staging
Worker (`env.staging` in `apps/web/wrangler.jsonc`) with its own D1 database,
driven by `apps/web/scripts/preview.ts`. It skips until the `setup-previews`
skill has created the account state. Rules that are easy to break:

- Previews inherit no bindings or vars. Every binding the app reads goes in
  `env.staging.previews` too, or it is `undefined` in previews (error 1101 on
  the route that touches it). Adding a binding means adding it in three
  places: top level, `env.staging`, `env.staging.previews`.
- The previews D1 entry holds `PREVIEW_DB_*_PLACEHOLDER`. `preview.ts` patches
  the built `dist/server/wrangler.json`, never `wrangler.jsonc`. Never commit a
  real id there.
- Every `wrangler preview` command takes `--env staging`. Without it, `preview
  delete` and `preview base-config` act on production.
- Secrets reach previews through the preview base config (`wrangler preview
  base-config secret put <NAME> --env staging`), copied once when a preview is
  created.
- `bun test` in `apps/web` covers the script's pure helpers. Full runbook:
  README.md "Pull request previews".

## Auth

Clerk. `apps/web/src/server.ts` runs `@clerk/hono`'s `clerkMiddleware()`, so
`getAuth(c)` works in any Hono route; `src/start.ts` wires the same auth into
TanStack Start, and `src/routes/__root.tsx` wraps the app in `<ClerkProvider>`.
`src/server/trpc/context.ts` puts the Clerk user id in `ctx.userId`, so
`protectedProcedure` admits signed-in users and answers 401 to everyone else.
Set `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` and
`VITE_CLERK_PUBLISHABLE_KEY` on a deployed Worker with `wrangler secret put`.

## Dev login (testing)

`apps/web` exposes a one-click dev login for local testing: `/login` has a
"Dev login (local only)" link (dev builds only) that hits `GET /api/dev-login`,
mints a Clerk sign-in token for a dedicated dev user, and redeems it at
`/dev-login` to establish a real session without going through Clerk's UI. Use
it to sign in as a real user when testing or driving the app via browser
automation, instead of going through Clerk's UI. Only active when
`DEV_LOGIN_EMAIL`/`DEV_LOGIN_PASSWORD` are set in `apps/web/.env.local` (never
set these in a deployed environment, since their absence is what disables the
route). Create/refresh the dev user with `bun run create-dev-user` from
`apps/web`.
