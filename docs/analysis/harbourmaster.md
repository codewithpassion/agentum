# Analysis: Harbourmaster (the starting repo)

Repo: `/home/roboto/devel/harbourmaster`, remote `git@github.com:codewithpassion/harbourmaster.git`. Read-only study, 16 Oct 2026. I ran no build, test or install.

## 1. Purpose and current state

Harbourmaster is a copy of Dom's `cf-tanstack-boilerplate` that `/project-init` has already turned into a named project. It has one working vertical slice (a public "notes" page backed by D1) and Clerk sign-in. It has nothing yet from the brief: no agents, MCP, triggers, files, logging or inbox.

What `/project-init` and the next commit did (`git log`, newest first):

| Commit | Date | What |
|---|---|---|
| `96f8111` Add Clerk auth | 2026-10-16 | The `add-clerk` skill: Clerk provider, `/login`, `/dev-login`, `create-dev-user` script, Hono and Start middleware, `userId` in tRPC context, `protectedProcedure` use (19 files) |
| `d81548e` Rename boilerplate to harbourmaster, add custom domain and D1 id | 2026-10-16 | `rename-project` (root `package.json` name `harbourmaster`, `.cta.json`, Worker `name`), custom domain `harbourmaster.rockyshoreslabs.io`, real D1 `database_id` |
| `e8c7932` Initial commit | 2026-10-16 | The template copy, including `docs/image.png` |

Git status: branch `main`, clean apart from untracked `docs/index.md`, `docs/log/` and `docs/analysis/` (other analysts' files, which I did not touch).

State of setup, checked without printing secrets:
- Package name is `harbourmaster`. The Worker name in `apps/web/wrangler.jsonc` is `harbourmaster`.
- Production D1 is `harbourmaster` with a real id (not `"local"`). A custom domain route is set.
- Staging is not set up. `env.staging` D1 `database_id` is still `"local"` and the previews placeholders are in place, so `setup-previews` has not run and `preview.yml` skips (it needs the `CLOUDFLARE_API_TOKEN` secret).
- Clerk is configured locally. `apps/web/.env.local` (gitignored) has values for `VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `DEV_LOGIN_EMAIL`, `DEV_LOGIN_PASSWORD` and `CLOUDFLARE_ACCOUNT_ID`. I could not tell from the repo whether the same secrets were put on the deployed Worker with `wrangler secret put`, or whether the Worker is deployed at all. `apps/web/dist/` and `apps/web/.wrangler/` exist, so it has been built and run locally.
- Leftovers from the template that `rename-project` did not touch: `README.md` and `apps/web/README.md` still say `boilerplate` in the template URL, `wrangler d1 create boilerplate` and `boilerplate-staging` examples, and `wrangler.jsonc` has a comment naming `boilerplate-staging`. The staging D1 name is already `harbourmaster-staging`, so only prose is stale.
- Tests exist only for the notes example and the preview script (section 2). There is no CI workflow for typecheck, lint or tests. The only workflow is `.github/workflows/preview.yml`.

## 2. Stack and deployment

| Area | What is in place |
|---|---|
| Runtime / tooling | Bun 1.3.11 (`packageManager`), Bun workspaces (`apps/*`, `packages/*`), Turborepo 2 (`turbo.json`: build, deploy, dev, preview, test, typecheck, cf-typegen) |
| Front end | TanStack Start (file router, SSR), React 19, Vite 8, Tailwind 4, shadcn `radix-nova` style plus `@base-ui/react`. TanStack packages are pinned to `latest` in `apps/web/package.json` |
| Worker entry | `apps/web/src/server.ts`: a Hono app is `export default`. It mounts `clerkMiddleware()`, `/api/health`, `/api/dev-login`, `/api/trpc/*` (with `csrf()`), then `app.all("*")` hands everything else to TanStack Start |
| API | tRPC 11 over Hono (`@hono/trpc-server`). No transformer, so results must be plain JSON. No `createServerFn` |
| Data | D1 binding `DB`, Drizzle 0.44 (`drizzle-orm/d1`), plain SQL migrations in `packages/db/migrations`, applied by wrangler, not drizzle-kit |
| Auth | Clerk. `@clerk/hono` on the Worker, `@clerk/tanstack-react-start` for SSR, `@clerk/backend` for the dev-login token. Only a `userId` string reaches tRPC |
| Validation | zod 4 in `@repo/services` |
| Hosting | One Cloudflare Worker, `compatibility_date` 2026-08-19, `nodejs_compat`, observability on, custom domain route. Staging Worker (`env.staging`) with PR previews via Cloudflare Worker Previews and a per-PR D1 database |
| Lint / format | Ultracite 7.10.5 on Biome 2.5.6 (`biome.jsonc` extends core, react, tanstack, vitest). Husky pre-commit runs `ultracite fix`. A Claude Code `PostToolUse` hook (`.claude/settings.json`) runs `bun run fix` after every Write or Edit |
| TypeScript | `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, bundler resolution. One tsconfig per workspace, none at the root. "any forbidden" comes from Biome `noExplicitAny: error`, not from tsconfig |
| Tests | `bun test` in `packages/db` (`notes.test.ts`), `packages/services` (`notes.test.ts`) and `apps/web/scripts` (`preview.test.ts`, pure helpers). The db and service tests run the real migrations against in-memory `bun:sqlite`. No route, component or tRPC-router tests |
| Not present | Durable Objects, Queues, Cron, KV, R2, Workflows, Agents SDK, WebSockets, MCP, Slack |

## 3. Module map

| Path | Responsibility | Notes |
|---|---|---|
| `package.json`, `turbo.json`, `biome.jsonc`, `bun.lock` | Workspace, task graph, lint config | `prepare` runs `husky` and `turbo run cf-typegen` |
| `apps/web/wrangler.jsonc` | Worker, D1 binding, custom domain, `env.staging`, `env.staging.previews` | Every binding must be added in three places (CLAUDE.md) |
| `apps/web/worker-configuration.d.ts` | Generated `Env` type (`DB`, Clerk and dev-login vars) | Gitignored. `bun run cf-typegen` rebuilds it, and `typecheck` depends on it |
| `apps/web/src/server.ts` | Worker `fetch` entry: Hono routes, Clerk, tRPC mount, fallthrough to Start | Only place to add Worker exports (`scheduled`, `queue`, DO classes) |
| `apps/web/src/start.ts`, `router.tsx`, `routeTree.gen.ts` | TanStack Start instance (CSRF + Clerk request middleware), router, generated route tree | `routeTree.gen.ts` is committed and generated by the Start plugin or `bun run generate-routes` |
| `apps/web/src/routes/` | `__root`, `index`, `about`, `notes`, `login`, `dev-login` | `notes.tsx` is the template: loader calls `getTrpc().notes.list.query()` |
| `apps/web/src/server/trpc/` | `context.ts` (builds services per request, `userId`), `init.ts` (`publicProcedure`, `protectedProcedure`, error formatter), `router.ts` (`appRouter`, `me`), `routers/notes.ts` | Thin routers only. Server-only code |
| `apps/web/src/integrations/trpc/client.ts` | `getTrpc()`: in-process `unstable_localLink` during SSR, HTTP `/api/trpc` in the browser | |
| `apps/web/src/integrations/clerk/` | `provider.tsx`, `header-user.tsx` | Copied in by `add-clerk`. Templates kept in `.claude/skills/add-clerk/templates/` |
| `apps/web/src/components/` | `header`, `footer`, `theme-toggle`, `themed-toaster` (app-owned) | |
| `apps/web/src/components/ui/`, `src/lib/utils.ts`, `src/hooks/use-mobile.ts` | shadcn CLI output. About 55 components | Never hand-edit. Biome skips them. Has its own `CLAUDE.md` |
| `apps/web/scripts/` | `preview.ts` (create or delete PR preview and its D1), `preview.test.ts`, `create-dev-user.ts` | Bun scripts |
| `packages/db` (`@repo/db`) | Drizzle schema (`src/schema.ts`), table modules (`src/notes.ts`), browser-safe shapes (`src/shared.ts`), `migrations/`, `drizzle.config.ts` | `exports`: `.` (schema + `Database` type), `./notes`, `./shared` |
| `packages/services` (`@repo/services`) | Business rules and input validation (`src/notes.ts`: `createNotesService`, `createNoteInput`) | `exports`: `./notes` only. Depends on `@repo/db` and zod. Never reads `env` |
| `.claude/skills/` | `project-init`, `rename-project`, `add-clerk`, `setup-cloudflare`, `setup-previews` | `project-init` has `disable-model-invocation`, so the user must type it |
| `.github/workflows/preview.yml` | PR preview deploy and cleanup | Skips until `CLOUDFLARE_API_TOKEN` exists. Fork PRs get no preview |
| `docs/` | `index.md`, `log/`, `analysis/`, `image.png` | Knowledge side. Tasks live elsewhere |

Layering as built (CLAUDE.md "Services and tRPC"): route component or loader, then `getTrpc()`, then tRPC router, then service in `@repo/services/<module>`, then query functions in `@repo/db/<module>`. Everything the browser needs from the db package comes from `@repo/db/shared`.

## 4. Extension points

Exact files to touch for each kind of addition. "Capability" below means a Harbourmaster feature such as agents, connectors or the inbox.

| To add | Touch these files | Notes |
|---|---|---|
| A table | `packages/db/src/schema.ts` (table), run `bun run generate` in `packages/db`, commit `migrations/` including `migrations/meta/` | Local DB migrates on `bun run dev`. Remote: `wrangler d1 migrations apply DB --remote`. One D1 database, one schema file, one migration history |
| Query functions for it | New `packages/db/src/<name>.ts` taking `db: Database`; browser-safe types and constants in `packages/db/src/shared.ts`; one new line in `packages/db/package.json` `exports` (`"./<name>": "./src/<name>.ts"`); test `packages/db/src/<name>.test.ts` | Return plain JSON, keep the row type private. No validation here |
| A service | New `packages/services/src/<name>.ts` (`create<Name>Service(db)` plus an exported zod input schema); `exports` line in `packages/services/package.json`; test next to it | Services take a `Database` and parameters. They never read `env` or the request, so pass the user id, a queue or a DO stub in as arguments |
| Wire the service into the app | `apps/web/src/server/trpc/context.ts` (add to `Context.services` and `createContext`) **and** the copy at `.claude/skills/add-clerk/templates/apps/web/src/server/trpc/context.ts` | Both, or running `add-clerk` later drops it. `context.ts` already holds a `userId` from Clerk |
| A tRPC router | New `apps/web/src/server/trpc/routers/<name>.ts` (input schema plus one service call), register in `apps/web/src/server/trpc/router.ts` | Use `protectedProcedure` for signed-in users. For bearer-token machine callers (triggers, MCP) there is no procedure kind yet, see section 6 |
| A page route | New `apps/web/src/routes/<name>.tsx` (`createFileRoute`); `routeTree.gen.ts` regenerates on dev or build, commit it | Loaders call `getTrpc()`. Never `createServerFn`. Import only `@repo/db/shared` in components |
| A UI component | App-owned: `apps/web/src/components/<name>.tsx`. shadcn: `cd apps/web && yes '' \| bunx --bun shadcn@latest add <name> --yes` | Nothing app-owned in `components/ui/` |
| A plain HTTP endpoint (webhook, Slack events, bearer trigger, MCP server) | Add a Hono route in `apps/web/src/server.ts` before `app.all("*")`. Keep non-trivial logic in a service | `clerkMiddleware()` runs on `*`, so it must tolerate unauthenticated callers. Do not add `cors()` on routes that mutate via cookies. `csrf()` is only applied to `/api/trpc/*` today |
| A Worker binding (KV, R2, Queue, DO, AI, service) and its env vars | `apps/web/wrangler.jsonc` in three places: top level, `env.staging`, `env.staging.previews`. Then `bun run cf-typegen`. Local values in `apps/web/.env.local` and `.env.example`. Secrets: `wrangler secret put` and, for previews, `wrangler preview base-config secret put <NAME> --env staging` | Previews inherit no bindings. A missing one is `undefined` at runtime (error 1101). Never commit a real preview D1 id |
| A Durable Object (also the way to host Cloudflare Agents) | Class exported from the Worker entry: add `export { MyAgent } from "..."` in `apps/web/src/server.ts` (or a file it re-exports). `wrangler.jsonc`: `durable_objects.bindings` and `migrations` (`new_sqlite_classes`), repeated for `env.staging` and `env.staging.previews`. Then `cf-typegen` | Not yet in the repo, so unproven with the Cloudflare Vite plugin plus TanStack Start. The class must not import browser code. Business rules still belong in `@repo/services`, with the DO holding only state and coordination |
| A queue consumer or a cron handler | `wrangler.jsonc` (`queues.producers/consumers`, `triggers.crons`), and change `export default app` in `apps/web/src/server.ts` to `export default { fetch: app.fetch, scheduled, queue }` | The README warns that cron triggers do not fire in previews and `wrangler tail` does not support them |
| A Clerk-dependent change | `apps/web/src/server/trpc/context.ts` (userId source), `init.ts` (procedures), `apps/web/src/integrations/clerk/` | Org or role data is not in context today. Both context builders (HTTP and SSR) must change together |

How new Harbourmaster modules slot in. The repo is layered by tier, not by capability. Two workable shapes:

1. Slice by naming (fits the repo as is). For capability `agents`, add `packages/db/src/agents.ts`, `packages/services/src/agents.ts`, `apps/web/src/server/trpc/routers/agents.ts` and `apps/web/src/routes/agents*.tsx`. The "public API" of each tier is the `exports` subpath (`@repo/db/agents`, `@repo/services/agents`), which already plays the role of a barrel without being one. Tables still live in the single `schema.ts`, so a capability cannot be deleted by removing one folder.
2. One workspace package per capability, `packages/<capability>` with its own `exports` map (server entry, `./shared` for the browser). It would import only `@repo/db`'s `Database` type, zod and drizzle. This matches the global "copy the folder to move it" rule better, but it needs a decision on where its tables live. `packages/db/drizzle.config.ts` points `schema` at one file, so a per-package schema would need that config widened. I did not test that, so treat it as an open question.

Either way the service rule holds: a module gets config, data and actions through parameters (a `Database`, a user id, a queue or DO stub), and never imports a sibling module or `apps/web`.

## 5. Constraints from CLAUDE.md files and config

Top constraints that shape the architecture:

1. Layering. Route, then tRPC router, then service, then query functions. Routers stay thin (input schema plus one service call). Services take a `Database` and never read `env`. Only `@repo/services` imports `@repo/db/<table module>`. No `createServerFn`.
2. Server code must not reach the browser bundle. Components import only `@repo/db/shared`. `#/server/**`, drizzle and `cloudflare:workers` stay server-side. After touching the client, build and grep `apps/web/dist/client` for `drizzle`. tRPC has no transformer, so no `Date`, `Map` or `bigint` in results.
3. Wrangler bindings in three places, and previews inherit nothing. Never commit a real preview D1 id. Every `wrangler preview` command needs `--env staging`.
4. Migrations: `bun run generate` in `packages/db`, commit `migrations/` with `meta/`, apply with wrangler. A new service needs `context.ts` edited in two places.
5. Never hand-edit `apps/web/src/components/ui/`, `src/lib/utils.ts` or `src/hooks/use-mobile.ts`, and put nothing else in `components/ui/`.
6. Tooling: Bun only (no node, npm, vite CLI wrappers, dotenv, express, better-sqlite3). `bun:sqlite` in tests. Ultracite rules apply (`.claude/CLAUDE.md`): no `console.log` in production code, no `any`, top-level regex literals, no namespace imports, no spread in accumulators, explicit `await`, accessibility rules for JSX. Husky and the PostToolUse hook auto-fix on commit and on every edit.
7. Dev login routes only work when `DEV_LOGIN_EMAIL` and `DEV_LOGIN_PASSWORD` are set. Never set them on a deployed Worker, because their absence is the safety switch.
8. Auth in v1 matches the brief: Clerk, minimal permissions. `protectedProcedure` is the only gate.

The barrel conflict, stated precisely:

| Source | Rule |
|---|---|
| `~/.claude/CLAUDE.md` (user, global) | "Each capability gets one folder (e.g. `modules/survey/`) ... its `index.ts` barrel is the only public API." It also says "Project CLAUDE.md files and explicit requests override them." |
| `/CLAUDE.md`, section Database (project) | `@repo/db`: "One entry per module in `exports`, no barrel file." The `README.md` of `packages/db` and `packages/services` repeat it ("no barrel file") |
| `.claude/CLAUDE.md` (project, Ultracite) | "Avoid barrel files (index files that re-export everything)." |
| `node_modules/ultracite/config/biome/core/biome.jsonc` line 307 | `performance.noBarrelFile: "error"` (and `noReExportAll: "off"`, line 317). `biome.jsonc` extends this, so a re-export-only `index.ts` would be flagged by `ultracite check` and by the Husky pre-commit hook. I did not run Biome to confirm the exact trigger |

So the global rule loses inside this repo, by its own precedence clause, and the linter enforces that. The browser-bundle reason is real: one barrel over `@repo/db` would pull drizzle into client code.

What survives: the intent (one explicit public surface per capability, no reaching into internals). Honour it with `package.json` `exports` subpaths, one per module (`@repo/services/notes` is exactly this today). If a capability package really needs a single `index.ts`, it can only be one that holds real code or a single named entry, never a re-export hub, and a `./shared` subpath must stay separate from the server entry. The architect should record this choice in the project CLAUDE.md so it is not re-litigated.

Smaller mismatches worth knowing:
- The global rule says "A module imports only the framework, declared shared packages and its own files." The repo's `@repo/services` imports `@repo/db`, which fits ("declared shared package"). `apps/web/context.ts` imports every service by design, which is app wiring, not a module.
- The global stack default says tsconfig forbids `any`. Here Biome does it, not tsconfig.
- The global default says Wrangler env files are `.env` / `.env.*`, and `.dev.vars` is outdated. This repo uses `apps/web/.env.local` (and the build writes `dist/server/.dev.vars`, generated, not edited).

## 6. Gaps vs the brief

| Brief section | In place | Missing |
|---|---|---|
| Creating and running agents | Worker hosting, D1, per-request services. No agent concept | Agent table and config model, a create-agent UI, runtime choice (Cloudflare agent, Claude managed agents, remote machine), Durable Objects or the Agents SDK, machine and container registry, a local run mode |
| Talking to agents | tRPC, SSR loaders. No streaming | A chat or session UI (the shadcn `message`, `bubble`, `message-scroller` components exist in `components/ui/` but are unused), session storage tables, an MCP server endpoint so Claude can message agents, an inbox between agents, streaming (SSE or WebSocket) |
| MCP connectors and credentials | Nothing. `CLERK_SECRET_KEY` is the only secret handling | Connector registry, per-connector auth (OAuth, header), three credential cases (user, colleague, agent), a secret vault with encryption, an OAuth callback route, re-auth flow |
| Slack, triggers, gateways | Hono can host any route | Slack app install flow and events endpoint, bearer-token trigger endpoint, cron or routines (handler shape in section 4), file-landing triggers. No `protectedProcedure` equivalent for machine callers |
| Files | Nothing | R2 or Drive/Samba gateways, uploads, file-landing triggers |
| Logging and knowledge | Worker observability is on (`observability.enabled`) | An append-only action log table, a shared wiki or file-structure store, search |
| Auth and permissions | Clerk sign-in, `protectedProcedure`, dev login, custom domain | Any user, org or role data (Clerk id only), per-user data scoping (the notes example is public and global), a permission seam for later fine-grained rules, a machine-token path for agents |
| Delivery plumbing | Preview workflow (not yet enabled), Husky, Turbo | A CI workflow that runs `ultracite check`, typecheck and `bun test` on push, tests for routers and routes, staging setup |
| Housekeeping | | Stale `boilerplate` text in READMEs and one `wrangler.jsonc` comment, `latest` ranges on TanStack packages, the unused example `notes` slice and `about` route to remove or repurpose |

## 7. docs/image.png

A 965 by 531 px slide in an off-white, orange and charcoal palette, titled "THE SHIFT: From skills to a software factory". Top right: "Tessl runs 850 pull requests a week, 85 to 90% handled by agents end to end."

Four columns, each with a small icon (a dot, a partial ring, a four-node diamond, a grid of squares) show a maturity ladder:
- 01 Skills: "You prompt, it answers." One task at a time, a faster keyboard. Write down how the work is actually done; teams that skip this stall later.
- 02 Loops: "It runs, checks, retries." Work finishes without you in every step. The skill gets better each time it runs.
- 03 Graphs: "Split, fan out, merge." You design the graph, not the code. Extra parallel capacity buys higher quality and fungible work.
- 04 Software factory: "Standing capacity." Intent goes in, shipped software comes out. Verifiers and evals enforce the standard agents are otherwise free to ignore.

Footer, two blocks: "What it means for us" (the job moves from writing to designing and judging, fewer keystrokes, more decisions) and "What it means for organisations" (throughput stops scaling with headcount; the constraint becomes what you can specify, review and trust).

It is in the first commit (`e8c7932`), and no markdown file references it. I could not tell whether the template or Dom added it. It reads as a framing or inspiration image for the agent-platform direction, not a technical spec. I would not treat it as a requirement.
