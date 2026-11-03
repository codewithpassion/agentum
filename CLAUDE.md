
## Working process

The build runs as an Opus controller session with Sonnet dispatchers and Haiku workers, tracked as task files in `docs/tasks/`. The controller follows `docs/workflow.md` and runs from this checkout. A subagent follows its brief, which the workflow's templates write, and works in its own worktree under `/home/roboto/devel/harbourmaster-wt/`.

## Bun

Bun is the package manager, test runner and script runner: `bun install`, `bun test`, `bun run <script>`, `bunx <package>`. `apps/web` is TanStack Start built with Vite and runs on Cloudflare Workers, so Bun runtime APIs (`Bun.file`, `Bun.$`, `bun:sqlite`) stay in scripts and tests and never ship in the Worker. `apps/daemon`, from M1, runs on Bun itself. Run tests with `bun run test` from the root, not a bare `bun test`, so each package's `bunfig.toml` applies (`apps/web` preloads a `cloudflare:workers` shim).

## shadcn components

`apps/web/src/components/ui/`, `lib/utils.ts` and `hooks/use-mobile.ts` are shadcn CLI
output. Never hand-edit them, and put nothing else in `components/ui/`. `biome.jsonc`
excludes them at the `files` level because `ultracite fix` corrupts them. See
`apps/web/src/components/ui/CLAUDE.md`.

## Database (D1 + Drizzle)

Data access lives in `packages/db` (`@repo/db`), see its README. Rules that
are easy to break:

- Only `packages/services` imports `@repo/db/schema/*` and the other table
  modules; the app goes through the services (below). Anything a React
  component needs comes from `@repo/db/shared`. The other entries pull drizzle into the
  browser bundle. One entry per module in `exports`, no barrel file.
- Query functions take a drizzle instance, they never make one. The app passes
  `drizzle(env.DB)` from `drizzle-orm/d1`; the tests pass a `bun:sqlite` one. The
  parameter type is `Database` from `@repo/db`, which covers both.
- Changing `src/schema/*.ts` means running `bun run generate` in `packages/db` and
  committing `migrations/` including `migrations/meta/`.
- Multi-statement writes go through `atomic` from `@repo/db/atomic`, never
  raw `db.batch` or `db.transaction`. The `events` triggers are hand-written at
  the end of `0000_init.sql`; a migration that recreates `events` must add
  them back.
- Foreign keys are on (D1 enforces them, and `migrated()` turns them on in
  tests). Insert parents before children. A migration that recreates tables
  rebuilds parents first, because D1 cannot switch `foreign_keys` off.
- Migrations are applied by wrangler, not drizzle-kit: `wrangler d1 migrations
  apply DB --local` (which `bun run dev` does for you) or `--remote`.
- Local database: SQLite via Miniflare, in `apps/web/.wrangler`. No account, no
  Docker. Delete that folder for a clean slate.

## Services and tRPC

Business logic lives in `packages/services` (`@repo/services`), see its README.
The app reaches it only through tRPC, mounted in Hono at `/api/trpc`, with one
exception for bearer-authenticated Hono routes (below). Rules that are easy to
break:

- Layers: route component -> tRPC router (`apps/web/src/server/trpc/`) ->
  service (`@repo/services/<module>`) -> query functions (`@repo/db/<module>`).
  Routers stay thin: input schema plus one service call. Validation and rules
  go in the service. A service is a factory taking `{ db, ... }` plus the infra it
  needs (`atomic`, `blobs`, `clock`), built by the caller, and never reads
  `env`. Rows that must land together are written through `atomic`.
- No `createServerFn`. Route loaders and components call
  `getTrpc()` from `#/integrations/trpc/client`. It calls the router in-process
  during SSR and over HTTP in the browser, so it works in both.
- Two procedure kinds in `init.ts`: `publicProcedure` for anyone,
  `workspaceProcedure` for a user with an active, allowed Clerk organisation
  (narrows `ctx.principal` to the user principal, 401 otherwise).
  `context.ts` reads the Clerk session and resolves it to `ctx.principal`
  through `@repo/services/workspaces`. Bearer-authenticated Hono routes
  (`/mcp`, `/api/proxy`, machine, Slack, trigger and file routes) use
  `createPrincipalResolver` and call services directly, the one exception to
  "the app reaches it only through tRPC".
- A service method that reads workspace data takes the calling principal and
  calls `authorize()` from `@repo/services/authz` first, as the events reads do.
- A new service is built in `composeWith` in `apps/web/src/server/compose.ts`
  and added to `Services`. `context.ts` only passes `Services` on as
  `ctx.services`. add-clerk keeps a copy of `context.ts` in
  `.claude/skills/add-clerk/templates/apps/web/src/server/trpc/`, so a change to
  `context.ts` itself goes into both.
- Server code (`#/server/**`, drizzle, `cloudflare:workers`) must not reach the
  browser bundle. After touching the client, `bun run build` and grep
  `apps/web/dist/client` for `drizzle` to check. CI runs the same grep.
- Token prefixes live in `@repo/protocol/token-prefixes`. New tokens get `issue`
  (`ag_`), and production still holds `hm_` ones, so check a prefix with
  `matches`, `strip` or `pattern`, never a `startsWith` on one literal.

## CI

`.github/workflows/ci.yml` runs `bun install --frozen-lockfile`, `bun run check`,
`bun run test`, `bun run build` and the bundle grep, in that order, after copying
`apps/web/.env.example` to `apps/web/.env` so `wrangler types` knows the secrets. Dom is on the
free GitHub plan, so its only trigger is `workflow_dispatch`. Add `push` and
`pull_request` triggers only when Dom says so (see `docs/workflow.md`).

## The rail

`apps/web/src/components/rail/` replaced the sidebar, and `components/rail-pane/` is the main pane on `/desk`. The spec is `docs/ux-review/rail/spec.md`. Rules that are easy to break:

- A new page goes in `rail/find-registry.ts`, or `find-registry.test.ts` fails. Find is the only way to reach most pages.
- An agent asks `agents.owner_user_id`, falling back to `created_by`. That is visibility only: any member can still answer any request.
- Anything a person must act on should reach `desk.railSources`, or it won't show in Needs you.

## Agent connections

Agentum speaks A2A 1.0 as server and client (`packages/a2a`,
`packages/services/src/a2a`, `apps/web/src/server/routes/a2a.ts`). The spec is
`docs/v3/agent-connections.md`, and each package has a README. Rules that are
easy to break:

- Tokens (`ag_a2a_`, and `hm_a2a_` from before the rename) work only on `/a2a`.
  `createPrincipalResolver` ignores both prefixes,
  so a leaked key fails on `/mcp` and everywhere else. The `/a2a` routes are
  mounted before Clerk and never under `cookieGroup()` or `csrf()`.
- No MCP tool may create, approve, widen or revoke a connection. An API key, an
  OAuth client, a run, a machine, a trigger and a peer are all refused by
  `requireSession`. Only an org admin or the agent's owner on a browser session
  connects, approves or widens. Any member may revoke or approve a message.
- A peer's text is outside input. It reaches an agent only through the speaker
  envelope with `from.kind: "peer"`, never as a message a member wrote, and a
  peer run has `onBehalfOfUserId = null`.
- Every `/a2a` request re-reads the connection row. Cache nothing about a
  connection, or a revoke stops working on the next request.
- Both bindings call `runOperation` in `routes/a2a-ops.ts`. Change an operation
  there, once. Errors come from `A2A_ERRORS` in `packages/a2a/src/errors.ts`
  (section 5.4 of the v1.0.0 spec: 409 for `TaskNotCancelableError`, 415 for
  `ContentTypeNotSupportedError`), and both bindings answer `application/json`.
  Params go through `acceptProtoNames` first, because ProtoJSON allows `task_id`.
- `packages/a2a` imports only `zod`: no database, no Worker API, no other
  workspace package.
- Plain HTTP and loopback peers are for dev builds only. `allowLoopback` in
  `createConnectionsService` and `createPushConfigs` and `allowHttp` in
  `createPeerFetch` all come from `devFakeRuntime`. A production build refuses
  both, and `compose-a2a.test.ts` and `a2a-transport.test.ts` test it.
- After a change to the A2A server, client or pairing, run the interop scripts
  from the repo root: `bun scripts/e2e/a2a-interop.ts` (the official SDK),
  `a2a-tck.ts` (the official TCK), `a2a-hermes.ts` (a real Hermes) and
  `a2a-two-deployments.ts` (two dev servers). They start real `vite dev`
  Workers and sign in through the Clerk dev instance, and they say at the top
  what they download and where. Third-party checkouts go outside the repo.

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
`src/server/trpc/context.ts` turns the session's user id and active
organisation into `ctx.principal`, so `workspaceProcedure` admits users whose
active organisation has a `workspaces` row and answers 401 to everyone else. A
workspace is one Clerk organisation, and the row is what admits it: no request
makes one, so a Clerk organisation created anywhere else never gets in. Only
`workspaces.create` makes a row. A deployment's first workspace has no admin to
do that, so run `bun run add-workspace --org <id> --name <name> (--local |
--remote [--env staging])` from `apps/web`. It checks the organisation exists on
the Clerk instance for that environment and inserts through `wrangler d1
execute`. Turn on Clerk's restricted sign-up and Organizations in the Clerk
dashboard too. Set `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` and
`VITE_CLERK_PUBLISHABLE_KEY` on a deployed Worker with `wrangler secret put`.
Production runs on the production instance of the Clerk application "Agentum",
on `agentumbot.io` (frontend API `clerk.agentumbot.io`). It belongs to Agentum
alone. Staging, previews and local use the Clerk development instance. The
production keys live in the gitignored `apps/web/.env.agentum-production.local`,
and `bun run build` reads the publishable key from it through `vite build --mode
agentum-production`. The old shared production instance on `rockyshoreslabs.io`
also serves another app, so never change its settings.

The workspace menu in the rail header (`apps/web/src/components/rail/workspace-menu.tsx`) lists only organisations with a `workspaces` row, so it is not Clerk's OrganizationSwitcher. `New workspace` is for org:admin only, and `workspaces.createFromSession` enforces that on the server, so hiding the button is not the check. Switching workspace ends in a full page load to `/desk`, because loaders, polls and the rail hold the old workspace's data. `signedInProcedure` in `init.ts` serves a signed-in user with no workspace (`ctx.userId`), while `workspaceProcedure` still answers 401. `context.ts` now carries `userId`, so a change to it goes into the add-clerk copy too. The `/choose-organization` picker lists the same rows (`workspaces.mine`) with no create or invitations. `ctx.userId` covers pending sessions, `ctx.principal` does not.

Invitations are sent from the same menu, `Invite people`, by `workspaces.inviteFromSession` (org admin on a browser session, organisation from the principal). Never send one from Clerk's organisation profile: it carries no redirect URL, so a new user lands on the Clerk instance's home URL and not on `/accept-invitation`. The profile is opened with its own invite button hidden. The invitation's `redirectUrl` is `PUBLIC_BASE_URL/accept-invitation?org=<id>`, so a deployment with an empty `PUBLIC_BASE_URL` (previews) cannot invite. `routes/accept-invitation.tsx` shows `<SignUp>` or `<SignIn>` by `__clerk_status`. Once signed in it asks `workspaces.hasWorkspace` whether `org` has a `workspaces` row, and with no row it does nothing (no accept, no `setActive`). A member gets `setActive` then `/desk`. A person with a pending invitation sees `Join <organisation>`, and `accept()` runs only on that click, because the route can't verify a ticket on a signed-in session and a crafted link must not join anyone to anything. Clerk's bot check blocks headless Chrome on that form, so test it with agent-browser `--headed` on a virtual display (`Xvfb :97`, `DISPLAY=:97`).

Org and user ids in D1 belong to one Clerk instance. Moving the app to another
instance means rewriting them with `bun run migrate-clerk-ids` (dry run unless
`--apply`; `build-clerk-id-map` writes its mapping file), as X.1 did for the
old shared production instance. The Agentum v2 cutover does it again, from that
instance to the Agentum one, after `bun run copy-clerk-users` has made the
users and organisations there. The `events` triggers are dropped and put back
around that rewrite. The runbooks are `docs/reviews/tasks/X.1.md` and the Clerk
section of `docs/v3/agentum-v2-cutover.md`.

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
`apps/web`. It also creates a "Dev Workspace" organisation for the user.
`GET /api/dev-login` makes that organisation's workspace row in dev builds, so
one click works on a clean `.wrangler`, and `/dev-login` makes the organisation
active, so the login lands on the app and not on Clerk's create-organization
screen.

## Agent Task login

`bun run agent-login` from `apps/web` prints one Clerk Agent Task URL that signs
a user in on a deployed environment with no sign-in screen or device code. It is
how agents and browser tests sign in on staging, preview and production, where
dev login is off. Flags: `--env local|staging|preview|production` (default
`local`), `--pr <n>` (required for preview), `--email <address>` (default
`DEV_LOGIN_EMAIL` from `.env.local`), `--redirect <path>` (default `/`),
`--base-url <url>` (overrides the environment's base URL). Local, staging and
preview use `CLERK_SECRET_KEY` from `apps/web/.env.local` (the Clerk dev
instance; staging is built with `--mode staging` and holds the dev keys).
Production uses the Agentum production Clerk instance and reads its key from
`apps/web/.env.agentum-production.local` or the process environment, and `--email` must
name a user on that instance (the dev user is not there). The URL is a one-time
credential: open it in a fresh browser session and don't paste it into logs or
reports. The key is never printed. The session lands on the signed-in pages
only when the user has an active organisation that has a workspace row. On the production
instance Clerk does not activate an organisation for an Agent Task session. On
any instance, including dev, a user with no active organisation gets the same:
the session stays `pending` with the `choose-organization` task, which
the app treats as signed out. `PendingSessionGate`
(`src/integrations/clerk/pending-session-gate.tsx`) handles it. It activates
the user's only organisation that has a workspace row and reloads the page you
asked for. It sends a user with several rows or none to `/choose-organization`,
our own list of their organisations with a row.
Code: `apps/web/scripts/agent-login.ts`,
pure helpers in `agent-login-helpers.ts`.
