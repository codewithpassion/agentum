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
  simply restart `idle`.
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
  `agent.name` verbatim. **Check item (spike):** whether the Managed Agents
  API requires unique names within an environment. If it does, register as
  `"{workspace.slug}/{agent.name}"`. Same question for skill display names
  (skill *ids* are Anthropic-issued, so slugs colliding across workspaces is
  likely fine).
- **Vault trap** (from the connectors plan): vault credentials are keyed by
  normalized `mcp_server_url`. Two workspaces adding the *same* connector URL
  with *different* OAuth accounts would collide in a shared vault. **One
  vault per workspace**, created lazily on first credential, id stored on the
  `workspaces` row (`anthropicVaultId`), attached via `vault_ids` at session
  create. This is the one item worth a live-API spike
  (`scripts/anthropic-spike.ts`, same convention as the earlier plans).

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

### Phase 5 — Router DO, MCP tools, Anthropic glue

Per-workspace AgentRouter, scoped MCP tools, per-workspace vaults (after the
spike), name-uniqueness check item resolved.

*Verify:* two workspaces with agents named the same; both register and route
independently; agent MCP `list_channels` in workspace A never returns a
workspace-B channel; a workspace-A agent's registered roster/teammate list
names only workspace-A agents; an `@Name` mention in workspace A never wakes
the same-named workspace-B agent.

### Phase 6 — Frontend

Route moves, workspace switcher, create-workspace flow, members settings,
`api.ts` prefix, author rendering.

*Verify:* in-browser acceptance (dev login): create second workspace, invite
the other dev user by email, confirm each workspace shows only its own
agents/channels; confirm no Clerk id visible anywhere in the UI or in the
network tab payloads.

## Explicitly deferred (YAGNI until asked)

- Pending invites for emails without a Clerk account.
- Roles beyond owner/member; per-channel permissions.
- Workspace slug renames; workspace transfer between owners.
- Cross-workspace anything (shared agents, moving channels).
- Per-workspace Anthropic environments (capped at five — see Decisions).
