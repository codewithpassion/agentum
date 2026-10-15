# Analysis: flightdex (main dir)

Repo: `/home/roboto/devel/flightdex`. Analysed 2026-10-16. Read-only.

## 1. Purpose

Flightdex is not an agent platform. It is the owner's daily dashboard for Harbour Edge: a Twenty CRM pipeline (companies, contacts, deals, segments, a communication log) next to a Linear issue kanban board, in one screen. It keeps no database of its own. A tRPC backend-for-frontend calls the Twenty REST API and the Linear GraphQL API. The PRD says "agentic workflows" may join later, but nothing in this repo does agents, machines, sessions or MCP.

For Harbourmaster it is a source of one working stack skeleton (TanStack Start + Hono + tRPC + Clerk on Workers), a dev-login trick, a dashboard shell, and a kanban/command-palette UI. It has nothing for the agent-specific parts of the brief.

## 2. Stack and deployment

- Language and runtime: TypeScript, Bun workspaces, Turborepo (`turbo.json`). Bun 1.3.11, Biome 2.5.6 through Ultracite 7.10.5, husky pre-commit.
- Web: TanStack Start (React 19, TanStack Router file routes, `routeTree.gen.ts`), Vite 8, Tailwind 4, shadcn/ui on Base UI and Radix (`apps/web/src/components/ui/`, generated, never hand-edited), cmdk, sonner, recharts.
- Server: one Hono app as the Worker `fetch` handler (`apps/web/src/server.ts`). Order is `clerkMiddleware()`, then `/api/health`, `/api/dev-login`, `/api/trpc/*` (tRPC fetch adapter), then `app.all("*")` falls through to the TanStack Start handler.
- Data layer: tRPC 11 plus TanStack Query (`@trpc/tanstack-react-query`). No DB in main. `docs/PRD.md` and `PROGRESS.md` cycle 8 record that an earlier D1/Drizzle backend was ripped out for Twenty. The `wrangler.jsonc` has no `d1_databases`.
- Auth: Clerk (`@clerk/hono` on the server, `@clerk/tanstack-react-start` for SSR and UI). All `_app` routes need a session. `protectedProcedure` is the only authorisation. All users see all data. No roles.
- Hosting: Cloudflare Workers, name `flightdex`, custom domain `flightdex.rockyshoreslabs.io` (last commit). Earlier deploy was `flightdex.dominik-fretz.workers.dev`. Secrets by `wrangler secret put`: `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`, `TWENTY_API_KEY`, `TWENTY_BASE_URL`, `LINEAR_API_KEY`. Observability enabled. No cron, no queues, no DO, no R2, no KV.
- Env style: `.env.local` for dev (wrangler reads `.dev.vars`-style output into `dist/server/.dev.vars` at build). The repo does not use the `.env`/`.env.*` wrangler style Dom now prefers.
- Docs and code agree on the stack. The one stale spot: `apps/web/README.md` says "Hono as top-level fetch handler", which matches `server.ts`. `AGENTS.md` and `CLAUDE.md` are the stock Bun/Ultracite text plus a dev-login section.

## 3. Module map

| path | responsibility | notes |
| --- | --- | --- |
| `apps/web/src/server.ts` | Worker entry. Hono, Clerk middleware, health, dev-login, tRPC mount, Start fallthrough | 63 lines. Cleanest piece to lift |
| `apps/web/src/start.ts` | TanStack Start request middleware: CSRF (server fns only) + Clerk | 11 lines |
| `apps/web/src/server/trpc/{context,trpc}.ts` | Context factory (`userId`, `linear`, `twenty` clients), `protectedProcedure`, `mapCoreErrors` middleware | Maps `CoreError.code` to tRPC codes |
| `apps/web/src/server/trpc/routers/{crm,linear,communications,index}.ts` | Thin routers: zod input plus one core call | `appRouter`, `AppRouter` type exported |
| `apps/web/src/integrations/trpc/provider.tsx` | `createTRPCContext`, QueryClient with global toast on query and mutation error | Lesson-driven (see section 6) |
| `apps/web/src/integrations/clerk/{provider,header-user}.tsx` | ClerkProvider wrapper, user button | |
| `apps/web/src/routes/__root.tsx`, `_app.tsx`, `_public.tsx` | Route layouts. `_app` gates on `useAuth()`, redirects to `/login`, forces dark theme, renders Sidebar + Topbar | |
| `apps/web/src/routes/_public/{login,dev-login,about}.tsx` | Sign-in page, dev-login redeem (`signIn.ticket`) | dev-login has a one-shot `consumed` ref |
| `apps/web/src/routes/_app/*.tsx` | `index` (command view), `pipeline`, `accounts`, `providers`, `board`, detail routes | Each route is a few lines, UI in `features/` |
| `apps/web/src/features/shell/{sidebar,topbar,icons,tones}.tsx` | Left nav with counts, topbar with cmdk search and "New" menu, colour tones | 154 + 235 lines |
| `apps/web/src/features/delivery/board-section.tsx` | Kanban: HTML5 drag-and-drop, group by status or priority, board/list toggle, optimistic update with rollback | 515 lines, bound to Linear issue shape |
| `apps/web/src/features/crm/*` | Pipeline table and stats, customer/provider detail, dialogs, communication log | CRM-specific. Not reusable for agents |
| `apps/web/src/features/shared/*` | `inline-title-input`, `text-field`, `eyebrow` | Small |
| `apps/web/scripts/create-dev-user.ts` | Creates the Clerk dev user | 40 lines |
| `apps/web/scripts/provision-twenty.ts` | Idempotent creation of custom fields on Twenty | 314 lines. Twenty only |
| `packages/core/src/linear/{client,issues}.ts` | Dependency-free typed Linear GraphQL client, issue and customer-need logic | 649 + 109 lines |
| `packages/core/src/twenty/{client,mapping}.ts` | Typed Twenty REST client | 434 lines. Pattern for any REST connector |
| `packages/core/src/crm/*.ts` | Service functions: customers, contacts, deals, segments, communications, providers | Framework-free. Take clients as arguments |
| `packages/core/src/shared/errors.ts` | `CoreError` with code `not_found | conflict | unavailable | validation` | 14 lines |
| `packages/core/src/index.ts` | Barrel (the one allowed barrel, with a biome-ignore) | |
| `docs/` | `PRD.md`, `GLOSSARY.md`, `twenty-migration.md`, `linear-integration.md`, `gap-analysis-2026-09-16.md`, `briefs/linear-and-comms.md`, `design/ops-console.dc.html` | Docs were rewritten in cycle 12 to match the code. Mostly accurate |
| `PROGRESS.md` | 12 cycle log, 459 lines | Best source of lessons |
| `.claude/worktrees/linear-phase1/` | Leftover worktree copy | Ignore |

There are no tests in this checkout (no `*.test.*` outside `node_modules`). `apps/web/dist/` is a committed-or-left build output, ignore it.

## 4. Reusable pieces

| what | exact paths | copy code or borrow pattern | effort / fit | brief section |
| --- | --- | --- | --- | --- |
| Worker entry: Hono + Clerk + tRPC + Start fallthrough | `apps/web/src/server.ts`, `apps/web/src/start.ts` | Copy | Minutes. Harbourmaster already has this shape (its own CLAUDE.md describes the same Hono/tRPC/Clerk layout), so this is confirmation, not new | Auth and permissions |
| Layered tRPC: context factory, `protectedProcedure`, `CoreError` to `TRPCError` mapping | `apps/web/src/server/trpc/{context,trpc}.ts`, `packages/core/src/shared/errors.ts` | Copy the error mapping, borrow the rest | Small. The `mapCoreErrors` middleware is the useful part. `unavailable` maps to 500 on purpose | Auth and permissions |
| Dev login (Clerk sign-in token, one click, off unless env set) | `server.ts` lines for `/api/dev-login`, `routes/_public/dev-login.tsx`, `scripts/create-dev-user.ts`, CLAUDE.md "Dev login" | Copy | Harbourmaster's CLAUDE.md already documents the same feature, so it is likely already lifted. Check it carries the retry lesson (section 6) | Auth and permissions |
| tRPC client provider with global error toasts | `apps/web/src/integrations/trpc/provider.tsx` | Copy | 52 lines. Fits any dashboard | UI (all) |
| Dashboard shell: sidebar with live counts, topbar, cmdk search, New menu, forced-dark layout | `features/shell/{sidebar,topbar}.tsx`, `routes/_app.tsx` | Borrow the pattern, copy then rename | Medium. Nav items and counts are CRM/Linear-specific. Good starting point for fleet / agents / sessions / inbox nav | Creating and running agents (UI) |
| Kanban with drag-and-drop, optimistic update, hover and empty-column drop targets, group-by toggle, list view | `features/delivery/board-section.tsx`, `issue-card.tsx`, `routes/_app/board.tsx` | Borrow the pattern | Medium. Could back an agent task board or inbox triage. Tightly bound to `LinearIssue`. Playwright drags worked in headless Chromium | Talking to agents (inbox) |
| Typed, dependency-free REST/GraphQL client with injectable `fetch` and error-code mapping | `packages/core/src/linear/client.ts`, `twenty/client.ts` | Borrow the pattern | Small. Template for first-party connectors and for tests. Note the Workers `fetch` arrow-wrapper rule (section 6) | MCP connectors and credentials |
| Idempotent provisioning script against an external system | `apps/web/scripts/provision-twenty.ts` | Borrow the pattern | Small. Useful for connector setup scripts | MCP connectors and credentials |
| Service layer that takes clients as arguments, no framework imports | `packages/core/src/crm/*.ts`, `linear/issues.ts` | Borrow the pattern | Matches Dom's module rule and Harbourmaster's `packages/services` rule | General |
| Communication log as an append-only record of exchanges per entity | `packages/core/src/crm/communications.ts`, `features/crm/{log-communication-dialog,recent-communications,channel-chip}.tsx` | Borrow the pattern only | Stored as Twenty notes. It is a CRM log, not an action log. Weak fit | Logging and knowledge |
| Progress log habit (what we did, lessons, avoid next time) | `PROGRESS.md` | Borrow the practice | Useful for agents to read before touching a repo | Logging and knowledge |

Pointer to flightdex-v2: it has the parts of the brief that main lacks (encrypted per-tenant and per-member credentials, an MCP server with API keys and Clerk OAuth plus a client approval gate, signed webhooks, cron fan-out, tenant isolation tests). See [flightdex-v2.md](flightdex-v2.md) for the full analysis.

### Does flightdex-v2 supersede this repo?

Yes. `flightdex-v2` (76 commits, last 2026-10-11, "Merge the control plane ops tile (HEI-130)") keeps the same app shape but adds a D1 database with migrations, multi-workspace support, R2 file storage, cron-driven sync and webhooks from Linear and Twenty, a per-member encrypted Linear key, an MCP server with API keys and Clerk-based OAuth, and an ops tile fed by the control plane (`CONTROL_PLANE_URL` in its `wrangler.jsonc`). Its `wrangler.jsonc` deploys to `flightdex2.rockyshoreslabs.io`. The v2 README is only the stock scaffold text, so the real description lives in `PROGRESS.md` and `docs/`. Main (25 commits, 2026-08-19 to 2026-09-16) is the earlier Twenty+Linear-only version. Prefer v2 for anything Harbourmaster wants to lift, and read [flightdex-v2.md](flightdex-v2.md). Main is useful only as the simpler read of the base skeleton.

## 5. Brief coverage

- **Creating and running agents**: nothing. No agent model, no runtime choice (Cloudflare agent, managed agents, remote machine), no Docker/Podman, no machine records. The shell, forms and dialogs (`features/crm/new-*-dialog.tsx`) are the only help for a "create agent" UI, and only as layout patterns.
- **Talking to agents**: nothing. No chat UI, no sessions, no stored transcripts, no inbox. The kanban board is the nearest thing to an inbox and only as a UI pattern. There is no MCP server in main (v2 has one).
- **MCP connectors and credentials**: nothing in main. Secrets are plain Worker secrets, one global key per service, no per-user or per-agent credentials, no OAuth to third parties, no vault. The REST/GraphQL client pattern is the only reusable idea. v2 is where encrypted per-member credentials live.
- **Slack, triggers, gateways**: nothing. No Slack code, no webhook receiver, no cron, no bearer-token trigger endpoint in main. (v2 adds cron and webhooks.)
- **Files**: nothing. No upload, R2, Drive or Samba. (v2 adds R2 files routes.)
- **Logging and knowledge**: partly, and weakly. The communication log is a user-entered CRM record stored in Twenty, not an append-only action log. No wiki or knowledge base. Workers observability is switched on, nothing more.
- **Auth and permissions**: partly solved, and it matches the brief's first iteration. Clerk sign-in, session check in `_app.tsx`, `protectedProcedure` for every API call, dev login for automation. No roles or per-resource permissions, by design ("all users see all data"). No membership, orgs or per-user credential binding.

## 6. Gotchas and lessons

All from `PROGRESS.md`, spot-checked against code where noted.

- **Workers fetch**: passing the global `fetch` straight into a client throws "Illegal invocation". Wrap it in an arrow. Type it as a structural `(input, init) => Promise<Response>`, not `typeof fetch`, because newer wrangler types add `preconnect` and arrow wrappers then fail to typecheck. Both are in `linear/client.ts` header comments (verified).
- **Clerk dev login in browser automation**: Clerk needs a secure context (`crypto.subtle`). Over plain HTTP on a non-localhost origin, sign-in dies with "Cannot finalize sign-in without a created session". Headless Chromium ignores the insecure-origin flag. The fix was a TLS-terminating proxy that also rewrites `Host` and `X-Forwarded-Proto`. Even in a secure context the ticket redeem fails on the first attempt in a fresh browser context and works on the second. Mint a token after the context is ready, treat redeem as async, and wait for the redirect instead of re-navigating. The deployed HTTPS URL needs no proxy. This matters for Harbourmaster because agents drive the UI through dev login.
- **Dev-login safety switch** is the absence of `DEV_LOGIN_EMAIL`/`DEV_LOGIN_PASSWORD` in deployed env. It is one env var from being open. Harbourmaster could add a second guard (for example refuse unless the request host is localhost or the build is dev).
- **Wrangler non-interactive**: needs an explicit account id. An env var set in front of the first command of a pipeline scopes only to that command. Wrangler does not read `.env.local`.
- **Twenty API quirks** (`docs/twenty-migration.md`, cycles 8 and 11): REST note creates answer in a GraphQL-style envelope while reads are REST-shaped. SELECT option updates diff by id, so an id-less PATCH nulls every record's value (fixed in provisioning).
- **Drizzle/D1 error handling** (from the earlier D1 era, cycles before 8): the UNIQUE text sits in `error.cause`, not `error.message`, and substring matching on "UNIQUE" fires on user data. Walk the cause chain and match the exact SQLite phrase.
- **Query errors go silent** unless toasted. Put the toast in the QueryClient caches, not per call (`integrations/trpc/provider.tsx`, verified).
- **cmdk**: use the wrapped `CommandDialog`. Raw `Command` inside `Dialog` crashed the palette.
- **Copy-pasted components** carry their bugs three times (inline title editor). Extract early.
- **Stale generated types**: `apps/web/worker-configuration.d.ts` is untracked and goes stale. Run `cf-typegen` before judging a typecheck.
- **Design mistake recorded**: a second issue tracker (Twenty tasks) was built beside Linear, then removed in cycle 12 (`docs/gap-analysis-2026-09-16.md`). Lesson for Harbourmaster: do not rebuild what an external system of record already does.
- **Workflow note**: cycles 9 to 12 ran in a worktree and stayed uncommitted until a controller reviewed them. The `.claude/worktrees/linear-phase1` copy is left over.

## 7. Maturity

- Last commit: 2026-09-16 (`ac314f4`, "deploy: serve Flightdex on flightdex.rockyshoreslabs.io"). 25 commits, first 2026-08-19. Git status was clean at the time of reading.
- Tests: none in this checkout. The `.husky/pre-commit` hook and Ultracite/typecheck are the only gates. QA was done by hand in a browser through an agent. (v2 has many `*.test.ts` files.)
- Deployed: yes, on Workers at `flightdex.rockyshoreslabs.io`, verified in a real browser in cycle 12. I did not hit the URL.
- Completeness: complete for its own scope (CRM pipeline, Linear board, communication log, Clerk auth). Superseded by v2 and not extended since 2026-09-16. For Harbourmaster it is a skeleton reference, not a source of agent-platform features.
