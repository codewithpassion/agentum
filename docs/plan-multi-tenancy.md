# Agentum — Multi-Tenancy Plan (Workspaces)

Today the app is single-tenant with a login gate: `requireAuth` checks *that*
you are signed in, but no query ever asks *who* you are. Every user sees the
same agents, channels, skills, connectors and wiki. This plan introduces
**workspaces** as the tenant boundary:

- A workspace owns its channels, agents, categories, skills, connectors,
  bridges and wiki.
- A user can create multiple workspaces and belong to multiple workspaces.
- Members are added and searched **by email address**. Clerk user ids are an
  internal storage detail and must never appear in an API response or the UI.

## Decisions (made here, not to be relitigated per-phase)

1. **One shared D1 + `workspace_id` columns**, not a database per workspace.
   D1-per-tenant would mean dynamic bindings we don't have, N sets of
   migrations, and no cross-workspace queries for ops. A `workspace_id` column
   on root tables plus a membership check in middleware is the standard shape
   and fits Drizzle/D1 as used today.
2. **One shared Anthropic environment for the whole deployment.** The
   environment-id cache in `app_config` exists precisely because environments
   are capped (five concurrent slots — see `modules/anthropic/schema.ts`).
   Per-workspace environments would cap us at five workspaces. Agents from all
   workspaces share the environment; isolation comes from our DB scoping and
   per-agent MCP tokens, which is exactly the isolation we have today.
3. **Two roles: `owner` | `member`.** "Has a workspace" vs "belongs to a
   workspace" is the entire requirement. Owners can rename/delete the
   workspace and manage members; members can do everything else. No
   permission matrix (YAGNI).
4. **Existing Clerk users only.** Adding a member looks the email up via
   `clerkClient.users.getUserList({ emailAddress })` (the exact call
   `/api/dev-login` already makes). If no Clerk user has that email, the API
   says so and stops. A `workspace_invites` table for not-yet-signed-up emails
   is the obvious extension, deliberately deferred until asked for.
5. **Workspace slug as the public identifier.** `workspaces.slug` is globally
   unique, URL-safe, derived from the name at creation, immutable for now
   (rename changes the display name only). The frontend routes under
   `/w/$slug/…` and the API under `/api/w/:slug/…`. Internal FKs use
   `workspaces.id`; the middleware resolves slug → id once per request.

## Schema

### New tables

```
workspaces
  id            text PK
  name          text NOT NULL
  slug          text NOT NULL UNIQUE     -- url-safe, immutable
  createdAt / updatedAt

workspace_members
  workspaceId   text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
  id            text PK                  -- the member id the API exposes
  clerkUserId   text NOT NULL            -- NEVER serialized to the client
  email         text NOT NULL            -- snapshot at add time, for display/search
  name          text                     -- display-name snapshot from Clerk
  imageUrl      text                     -- avatar snapshot from Clerk
  role          text NOT NULL            -- 'owner' | 'member'
  createdAt
  UNIQUE (workspaceId, clerkUserId)
  INDEX (clerkUserId)                    -- "my workspaces" lookup
```

The `email`/`name`/`imageUrl` snapshots exist so member lists and message
authors render without a Clerk round-trip. They refresh opportunistically
(when the user themselves is active in the workspace, or on member-list
fetch); slight staleness is fine.

The `workspace_members.id` is what leaves the server — in member lists,
message author views, wiki authorship. `clerkUserId` exists only to join
against the Clerk session.

### `workspace_id` goes on **root tables only**

| Table | Change |
|---|---|
| `agents` | + `workspaceId`; `name` unique → **composite (workspaceId, name)**. `mcpTokenHash` stays globally unique — it is a credential lookup key. |
| `channels` | + `workspaceId` |
| `categories` | + `workspaceId` |
| `connectors` | + `workspaceId`; `url` unique → **(workspaceId, url)** |
| `connector_oauth_flows` | + `workspaceId` (`state` stays globally unique — it's a one-shot credential) |
| `skills` | + `workspaceId`; `slug` unique → **(workspaceId, slug)** |
| `wiki_pages` | + `workspaceId`; `slug` unique → **(workspaceId, slug)** |
| `channel_bridges` (bridges module) | + `workspaceId` — inbound Slack events are not Clerk-authed; the bridge row is what maps an event to a workspace |

Children **inherit tenancy through their parent FK and get no column**:
`messages`, `channel_members`, `attachments`, `message_mentions` (via
channel), `skill_files` (via skill), `browser_sessions`, agent activity,
`slack_users` / `slack_events_seen` (via bridge). `category_items` also stays
as-is — its `(itemType, itemId)` PK is safe because item ids are globally
unique. Write this down in each module's schema doc-comment so nobody adds
the column twelve times — but note the query consequence: fetching a child by
bare id must join or pre-check its parent's `workspaceId` (see
Authorization).

`app_config` stays deployment-level (it holds the shared environment id).

### Migration mechanics (D1/SQLite)

SQLite cannot `ADD COLUMN NOT NULL` without a default, and changing unique
constraints (`agents.name`, `skills.slug`, `wiki_pages.slug`,
`connectors.url`) requires a table rebuild. One migration, in this order:

1. Create `workspaces` + `workspace_members`.
2. Insert a **default workspace** (`slug: "default"`, name "Workspace").
3. Rebuild each root table with `workspace_id NOT NULL` defaulted/backfilled
   to the default workspace id, and the new composite uniques.
4. Backfill `workspace_members`: every distinct Clerk user id already present
   in the data (message authors with `author_type = 'user'`, channel members
   with `member_type = 'user'`, wiki authors) becomes an **owner** of the
   default workspace. Emails/names for these rows are backfilled by a
   one-shot script against the Clerk API (`scripts/`), not in SQL.
5. Extend `create-dev-user` to also guarantee the dev user a membership in
   the default workspace, so dev login keeps working.

**As shipped, steps 3–4 differ.** 0012 first took the `ADD COLUMN ... NOT NULL
DEFAULT 'ws_default'` route to avoid a rebuild, which left that default on the
tables for good — raw SQL that forgot `workspace_id` landed silently in the
default workspace. It has since been rewritten to drop and recreate the eight
root tables with no default, which is **destructive and assumes no pre-0012
data** (see the migration's header). The copy-then-swap rebuild the plan
imagined is not available: `DROP TABLE` on a cascade parent fires its
children's `ON DELETE CASCADE`, and `PRAGMA defer_foreign_keys` defers
violations, not actions. The step-4 membership backfill went with it — the
tables it read from are cascade children of the ones being dropped, so it could
only ever have seen an empty result.

## Authorization

One new middleware, mounted after `requireAuth` on everything under
`/api/w/:slug`:

```ts
// resolves slug -> workspace, checks workspace_members for c.get("userId"),
// then sets c.set("workspace", ws) and c.set("member", member)
export const requireWorkspace = createMiddleware<ApiEnv>(...)
```

**Hard rule, stated once and enforced everywhere: every query — including
every get/patch/delete-by-id — carries the workspace id in its WHERE.**
Scoping only the list endpoints is the classic cross-tenant IDOR, and today's
`:id` routes fetch by bare id (`getAgentById(db, id)` and friends). Service
signatures change to make the unsafe call impossible to write:

```ts
listAgents(db, workspaceId)
getAgentById(db, workspaceId, id)      // WHERE workspace_id = ? AND id = ?
updateAgent(db, workspaceId, id, input)
deleteAgent(db, workspaceId, id)
```

For child tables the check goes through the parent: e.g. message routes first
resolve the channel **within the workspace**, then operate on messages of that
channel (most already resolve the channel — the change is adding the scope to
that resolve).

Owner-only routes: workspace rename/delete, member add/remove/role-change.
Everything else needs plain membership.

### Route layout

All resource routers move under the workspace prefix; the routers themselves
mostly don't change beyond reading the workspace from context:

```
/api/workspaces                      GET (mine) / POST (create)
/api/w/:slug                         GET / PATCH / DELETE        (owner for write)
/api/w/:slug/members                 GET / POST {email, role}    (owner for write)
/api/w/:slug/members/:memberId       PATCH {role} / DELETE       (owner)
/api/w/:slug/members/search?email=   GET → Clerk lookup          (owner)
/api/w/:slug/agents|channels|categories|messages|attachments|wiki|connectors|skills|bridges
                                     — today's routers, re-mounted
```

Stays outside the workspace prefix, each with its own credential story:

- `/mcp/:agentToken` — token → agent → `agent.workspaceId` is the scope.
- `/api/bridges/slack` (Events API) — Slack signature → bridge row →
  `bridge.workspaceId` is the scope.
- `/api/connectors/oauth/callback` — one-shot `state` → flow row →
  `flow.workspaceId`.
- `/api/health`, `/api/dev-login` — unchanged.

## Never show the Clerk user id

This is currently violated in the product, not just at risk:
`messages.authorId` for `authorType: "user"` **is** the Clerk userId
(`modules/messaging/routes/channels.ts:183`), it is serialized in every
`MessageView`, and `lib/authors.ts` renders it as the literal display name
for any user who isn't the viewer. Same pattern in wiki authorship
(`modules/wiki/routes.ts`) and `channel_members` rows with
`member_type = 'user'`.

Fix at the serialization boundary, not with a data rewrite:

- **Storage keeps the Clerk userId** in `messages.authorId`,
  `channel_members.member_id`, wiki author fields. It is stable across
  membership churn and re-adds; `workspace_members.id` is not.
- **Views translate.** Wherever a user id would leave the server, resolve it
  through `workspace_members` (one batched lookup per request) and emit
  `{ memberId, name, email, imageUrl }` — mirroring how agent authors already
  resolve through the agents module. A user id with no surviving membership
  renders as "Former member".
- `lib/authors.ts` drops the `name: message.authorId` fallback and consumes
  the resolved author object; `isSelf` compares `memberId` against the
  viewer's own membership (returned by `GET /api/workspaces` /
  `requireWorkspace` context), never the Clerk id.
- Member search takes an email, calls
  `clerkClient.users.getUserList({ emailAddress: [email] })`, and returns
  `{ email, name, imageUrl, exists }` — the Clerk id stays server-side and is
  written straight into `workspace_members`.
- Sweep for other leaks in the same pass: realtime payloads
  (`ChannelRoom` broadcasts reuse the message view — fixing the view fixes
  the socket), attachment views, activity views, `/api/health` (currently
  echoes `userId` — drop it or return a boolean).

## Durable Objects

- **AgentRouter** is a global singleton (`idFromName("router")`,
  `modules/router/agent-router.ts:58`). It becomes **one per workspace**:
  `idFromName(workspaceId)`; every `routerStub(env)` call site gains a
  workspace argument, and any `listAgents` the router makes is scoped. The
  old singleton's in-DO state is allowed to die in the migration — agents
  simply restart `idle`. (Shipped; see Phase 5.)
- **ChannelRoom** (`idFromName(channelId)`) and **AgentComputer**
  (`idFromName(agentId)`) are keyed by globally-unique ids and need **no
  change**. Noted here so nobody "fixes" them.

## MCP & Anthropic side

- The agent MCP endpoint already authenticates per agent; tools in
  `modules/mcp/tools.ts` gain the scope `agent.workspaceId` on every query
  (list_channels, wiki, etc.). The server `instructions` string can name the
  workspace.
- **Cross-module `listAgents` call sites** — these are cross-tenant leaks the
  API-level tests won't catch, because they leak through prompts and routing,
  not response bodies. Each becomes workspace-scoped:
  - **Roster sync** (`anthropic/service.ts`, and `resyncRostersWithAnthropic`
    called on agent delete): the teammate roster registered with Anthropic
    today lists *all* agents — unscoped, workspace A's agents would be named
    in workspace B's system prompts.
  - **Mention resolution** (`messaging/service.ts`): `@Name` → agent must
    resolve within the channel's workspace, or a mention in workspace A can
    match and wake a workspace-B agent with the same name.
  - **Router notify** (`router/notify.ts`): covered by the per-workspace
    router, but its agent lookups take the scope explicitly too.
- **Agent names are only unique per workspace now**, and `syncAgent` sends
  `agent.name` verbatim. **Check item (spike): settled — names stay verbatim.**
  See Phase 5 below for the evidence.
- **Vault trap** (from the connectors plan): vault credentials are keyed by
  normalized `mcp_server_url`, so two workspaces adding the *same* connector
  URL with *different* OAuth accounts would collide in a shared vault.
  **Settled by Phase 4 already, at a finer grain than this plan proposed** —
  see Phase 5 below. No `workspaces.anthropicVaultId`.

## Frontend

- **Routes** move under `/w/$slug/`: today's `index` (chat), `skills.*`,
  `connectors.*`, `wiki.*`. `/` redirects to the user's first workspace or to
  a create-workspace screen if they have none.
- **`lib/api.ts`** centralizes the prefix: every fetcher takes/closes over the
  active workspace slug (`/api/w/${slug}/…`). One change site, not fifty.
- **Workspace switcher** in the header: lists memberships
  (`GET /api/workspaces`), switches by navigating, "Create workspace…" entry.
- **Members settings page** (`/w/$slug/settings/members`): list members
  (email, name, role), add-by-email with the search endpoint (found → add;
  not found → "No account with that email"), remove / change role
  (owner-only). Shows emails, never ids.
- **Author rendering**: `lib/authors.ts` consumes the resolved
  `{ memberId, name, email, imageUrl }` author from the API (see above).

## Phases

Rollout order is schema → authz → API scoping → identity views → DOs/MCP →
frontend, each landable and verifiable on its own.

### Phase 1 — Schema & backfill

Workspaces + members tables, `workspace_id` on root tables, composite
uniques, default-workspace backfill, membership backfill script,
`create-dev-user` extension.

*Verify:* migration runs on a copy of the existing local DB; existing data
lands in the default workspace; existing users are owners; app still boots
(routes unchanged so far — services may take a hardcoded default-workspace
lookup for one commit).

### Phase 2 — Workspace API & authz middleware

`/api/workspaces` (list mine, create), `/api/w/:slug` (get/rename/delete),
members CRUD + email search, `requireWorkspace`, roles.

*Verify:* unit tests for the middleware (non-member → 404, member → ok,
member-of-other-workspace → 404 — 404 not 403, don't confirm existence);
member add by email against the dev Clerk instance; Clerk id absent from
every response body (test asserts on the serialized JSON).

### Phase 3 — Scope every resource router

Re-mount routers under `/api/w/:slug`, thread `workspaceId` through every
service function including all by-id reads/writes, child-table access via
scoped parent resolve, categories/attachments included.

*Verify:* the IDOR test — two workspaces seeded, user A requests workspace
B's agent/channel/message/skill/wiki/connector by id through their own
workspace path → 404 in every router. This test is the point of the phase.

### Phase 4 — Identity views (email, not Clerk id)

Author resolution through `workspace_members` in message/wiki/member/realtime
views, `authors.ts` rewrite, `isSelf` via memberId, health-route cleanup.

*Verify:* grep-level test that no API response schema contains
`clerkUserId`/raw `user_…` ids — including channel member lists, whose
`member_type: 'user'` rows carry Clerk ids as `memberId` today; two-browser
test: user B sees user A's messages with A's name/email, not an id.

**Shipped**, with three decisions worth recording:

- **`imageUrl` is an accepted residual.** A Clerk-hosted avatar is
  `https://img.clerk.com/<base64url>`, and the token decodes to
  `{"type":"default","iid":"ins_…","rid":"user_…"}` — the Clerk id is *inside
  the URL*, encoded. Every API and UI **field** is free of the id, which is
  what the rule asks for; making the URL free of it too means proxying avatars
  through our own origin, which is future work and not worth a phase. The leak
  scanner (`modules/workspaces/clerk-id-leaks.ts`) matches the literal id, so
  the encoded form passes without an exemption — the reasoning is in its
  header comment so nobody "fixes" it by accident.
- **`MessageView.authorId` changed meaning** rather than growing a sibling: it
  is the agent id for an agent, the external handle for a bridged surface, and
  the *workspace member* id for a person — `""` when that membership is gone.
  The display fields live in a new `author: { memberId, name, email, imageUrl }`,
  set only for `authorType: "user"`. `WikiRevisionView` follows the same shape.
- **Channel member lists drop user rows whose membership is gone.** A message
  author is history and still resolves ("Former member"); a member list is who
  is in the channel *now*, and a row with no member id is one the client can
  neither name nor remove. The orphaned `channel_members` row survives in the
  database, unreachable — cleaning those up on member-remove is future work.

### Phase 5 — Router DO, MCP tools, Anthropic glue

Per-workspace AgentRouter, scoped MCP tools, per-workspace vaults (after the
spike), name-uniqueness check item resolved.

*Verify:* two workspaces with agents named the same; both register and route
independently; agent MCP `list_channels` in workspace A never returns a
workspace-B channel; a workspace-A agent's registered roster/teammate list
names only workspace-A agents; an `@Name` mention in workspace A never wakes
the same-named workspace-B agent.

**Shipped.** Phase 3 had already scoped the roster resync, `@Name` resolution
and every MCP tool query, so what was left was the router, two identity leaks
in the agent-facing views, and the two check items — both of which came back
"nothing to build":

- **Agent names go to Anthropic verbatim.** `scripts/anthropic-spike.ts names`
  (run 2026-08-20 against the live API) created two agents with an identical
  name, then renamed a third *into* that name: all three were accepted and all
  three came back from `agents.list`. Duplicates are not refused. Nor is the
  environment the right frame for the question — `beta.agents.create` takes no
  environment; agents live in the organisation and the environment only enters
  at session create, so the cap in the Decisions section is unrelated. Nothing
  round-trips a name back from Anthropic (registration is by id), so a
  `"{slug}/{name}"` prefix would have bought only noise in the console and a
  second name to keep in step. The same reasoning covers skill display names.
- **Vaults were already per *connector*, which is finer than per workspace.**
  The connectors plan decided one vault per connector (20 credentials/vault,
  `mcp_server_url` unique *within* a vault — docs/plan-connectors-skills.md),
  and `connectors` is unique on `(workspace_id, url)`. So two workspaces adding
  the same URL get two connector rows, two vaults and two credentials; session
  create passes exactly the vaults of the agent's own assigned connectors.
  There is no shared vault to split and no deployment-level vault id anywhere
  (`app_config` holds only the environment id), so the proposed
  `workspaces.anthropicVaultId` would have been a coarser scheme bolted over a
  correct one. Kept as tests instead of a migration.

Two identity fixes went in alongside:

- **`read_channel`'s `beforeId` was a cross-workspace existence oracle.** An
  unscoped `getMessage` answered "No message with id X" for an id that does not
  exist and handed back a working cursor for one that exists in *another*
  workspace — so any agent could probe for message ids across the whole
  deployment. It resolves through `getMessageInWorkspace` now, the same scope
  `read_thread` already used, and the two cases are indistinguishable.
- **Agents are told people's real names.** `mcp/format.ts` rendered every human
  as `"User"` and the router's wake text as the same; both now read
  `MessageView.author`, which Phase 4 already resolves through
  `workspace_members` (with the "Former member" fallback). Names only — an
  agent needs to address someone in a channel, and an email address is not how.

**Router Durable Object migration.** `idFromName("router")` became
`idFromName(workspaceId)`, and the workspace travels on `MessageNotification`
because a Durable Object cannot read back the name it was addressed with. The
old singleton's storage is *not* migrated: its sessions belonged to a router
nothing can reach any more. It retires itself instead — its last scheduled
alarm finds no workspace in storage, clears the alarm and drops everything.
Migration 0014 resets `agents.session_id`/`status`, which are that singleton's
state mirrored into D1: without it agents would claim "working" against dead
sessions, and the connector-resync gate (which waits for `session_id` to be
null) would stay shut for a whole extra session.

### Phase 6 — Frontend

Route moves, workspace switcher, create-workspace flow, members settings,
`api.ts` prefix, author rendering.

*Verify:* in-browser acceptance (dev login): create second workspace, invite
the other dev user by email, confirm each workspace shows only its own
agents/channels; confirm no Clerk id visible anywhere in the UI or in the
network tab payloads.

**Shipped.** Four decisions are worth recording:

- **The API client is a factory, not an ambient slug.** `createApi(slug)`
  returns every fetcher closed over `/api/w/:slug`, and `WorkspaceProvider`
  (`lib/workspace-context.tsx`) hands components the instance for the workspace
  in the route through `useApi()`. The obvious cheaper move - a module-level
  "current workspace" set by the layout - was rejected: this app server-renders
  in a Worker, so a mutable module global is shared across concurrent requests,
  and a cross-tenant leak is exactly what this plan exists to prevent. The
  factory also buys the refetch for free: `api` is memoized per slug, so it is a
  hook dependency, and every list reloads when the slug changes.
- **The provider is keyed by slug.** TanStack Router keeps a route component
  mounted when only a parameter changes, so without `key={workspaceSlug}` the
  previous workspace's agents and channels would stay on screen until the new
  fetch landed - and the open channel socket with them. Keying the provider
  resets all of it at the moment of the switch.
- **The switcher lives in the chat sidebar, not `components/header.tsx`.** That
  header renders only on `/about` and `/login`; the app screens own the whole
  viewport and start with the sidebar's title row, which is where the switcher
  replaces the static "Agentum". Switching drops the search params: a `channel`
  or `agent` id from one workspace names nothing in the next.
- **Legacy `/api/…` URLs in stored markdown are rewritten once, in the data.**
  Wiki asset images and pasted screenshot links written before Phase 3 point at
  the pre-workspace routes and 404 now. `scripts/rewrite-legacy-urls.ts`
  (`bun run rewrite-legacy-urls`) rewrites them to `/api/w/default/…` in
  `messages`, `wiki_pages` and `wiki_revisions`, and is idempotent - a URL
  already under `/api/w/` is left alone. A render-time patch in the markdown
  renderer was the alternative; it was rejected because those URLs are data that
  went stale, the rule would have to live forever, and the database would go on
  holding links that lead nowhere.

*Acceptance* (dev login, local dev server; screenshots in
`docs/acceptance/multi-tenancy/`): landed on `/w/default` with its channels and
message history (01, 02); created a second workspace from the switcher and found
it empty - no agents, channels, skills or connectors from the default one (03,
04, 05); created an agent and a channel in it and switched back and forth, each
workspace showing only its own (06, 07, 08, 09); every request went to
`/api/w/<slug>/…` for the workspace on screen, including the channel socket;
members settings listed the dev user by name, email and role, and an unknown
email answered "No account with that email" (10, 11); an unknown slug gave the
"workspace not found" screen with the switcher rather than a crash (12); a wiki
page's rewritten asset URL loaded (13); skills were present in the default
workspace and absent in the new one (14, 15). A scan of fifteen API payloads
across both workspaces for `user_[A-Za-z0-9]{4,}` outside `imageUrl` found zero
matches.

## Explicitly deferred (YAGNI until asked)

- Pending invites for emails without a Clerk account.
- Roles beyond owner/member; per-channel permissions.
- Workspace slug renames; workspace transfer between owners.
- Cross-workspace anything (shared agents, moving channels).
- Per-workspace Anthropic environments (capped at five — see Decisions).
