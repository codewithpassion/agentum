# Agentum — Slack App per Agent Plan

Today the Slack bridge runs on one deployment-level Slack app:
`SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` are Worker secrets, every mirrored
message posts as the single bot with a `Name:` prefix, and one events URL
(`/api/bridges/slack`) is verified against the one signing secret. This plan
moves to **one Slack app per agent**, set up through a guided wizard in the
agent's settings:

- Each connected agent is its own Slack app / bot user — real identity in
  Slack (own name, avatar, mentions, presence).
- The wizard generates the app manifest (copy to clipboard), walks through
  the api.slack.com steps right there, then accepts and verifies the tokens.
- Tokens are stored per agent in D1, encrypted the same way connector tokens
  already are.

Expected scale: a couple of connected agents per workspace.

## Decisions (settled here)

1. **The connection is a workspace-scoped row bound to one agent.** New
   `slack_apps` table in the bridges module. One app ↔ one agent (that is the
   point of the feature); an agent has at most one Slack app.
2. **Clean break from env credentials.** `SLACK_BOT_TOKEN` /
   `SLACK_SIGNING_SECRET` and `readSlackConfig` go away entirely. No
   deployment has live bridges (prod DB is fresh, local is fresh), so there
   is nothing to migrate. The old `/api/bridges/slack` route is removed with
   them; the leftover prod secrets get deleted at deploy time.
3. **Per-app events URL**: `/api/bridges/slack/:slackAppId`. Inbound
   signatures are verified against *that row's* decrypted signing secret.
   The URL id is an unguessable row id, but it is not a credential — the
   signature is.
4. **Draft-then-activate lifecycle.** The manifest needs the events URL, and
   the URL needs the row id — so the wizard creates a `draft` row first
   (step 1), and tokens arrive later (step 2). **A draft app answers Slack's
   `url_verification` handshake unauthenticated** — it only echoes Slack's
   own challenge, leaks nothing, and it is what makes the from-manifest flow
   verify green on the first try, before we hold the signing secret. Every
   other event, and everything once the row is `active`, requires a valid
   signature. Documented at the route.
5. **Token verification via `auth.test`.** Step 2 posts the `xoxb-` token +
   signing secret; the server calls `auth.test` with the token, which both
   validates it and returns `team_id` / `team` / `bot user` — stored on the
   row for display and for the mirror's self-identification. Invalid token →
   the Slack error string surfaces in the wizard. The signing secret cannot
   be pre-verified (only an inbound event proves it); the row goes `active`
   on token verification and the first verified event confirms the secret.
6. **Encryption reuses the connector idiom**: AES-GCM via `CONNECTOR_KEY`
   (`modules/connectors/crypto.ts`), IV-prepended, self-describing values.
   Extract/share the helper rather than copying it. Tokens are write-only:
   no API response ever returns them, masked or otherwise.
7. **A bridge belongs to a connection.** `channel_bridges.slack_app_id`
   (NOT NULL). The bridge's `agent_id` keeps its current meaning (the agent
   `<@BOTID>` mentions rewrite to) and is set from the app's agent.
8. **Event ownership filter instead of cross-app dedup.** Two connected
   bots sitting in the same Slack channel would both receive `message`
   events. An event is processed only when the bridge row for that Slack
   channel belongs to the app the event arrived for; otherwise it is 200-ack'd
   and dropped. One bridge per external channel (existing unique) means one
   owner, so no double-ingest and no reliance on message-key dedup for this.
9. **Mirroring posts through the bridge's app token.** Messages authored by
   the app's own agent post as the bot itself with **no** name prefix — the
   bot *is* the agent. Everyone else (users, other agents) keeps the
   `Name:` prefix. The echo-loop guard (origin check) is unchanged.

## Schema

```
slack_apps                              (bridges module; workspace-scoped root)
  id             text PK               -- appears in the events URL
  workspaceId    text NOT NULL         -- tenant boundary (no cross-module FK)
  agentId        text NOT NULL         -- the agent this app speaks as
  status         'draft'|'active'|'error'
  botTokenEnc    text                  -- AES-GCM, null while draft
  signingSecretEnc text                -- AES-GCM, null while draft
  teamId / teamName / botUserId        -- from auth.test, null while draft
  lastError      text                  -- e.g. auth.test failure
  createdAt / updatedAt
  UNIQUE (agentId)                     -- one app per agent
  INDEX (workspaceId)
```

`channel_bridges` + `slack_app_id text NOT NULL` (both DBs are empty — the
migration may assume no rows; follow 0012's fresh-DB precedent). `slack_users`
and `slack_events_seen` are unchanged.

## API (workspace-scoped, under /api/w/:workspaceSlug)

```
POST   /agents/:id/slack-app            -> create draft (409 if exists),
                                           returns { slackApp, manifest, requestUrl }
GET    /agents/:id/slack-app            -> status view + manifest again
                                           (draft: for re-copy; never tokens)
PUT    /agents/:id/slack-app/tokens     -> { botToken, signingSecret };
                                           auth.test; -> active view or 422 + Slack error
DELETE /agents/:id/slack-app            -> remove app row; its bridges are
                                           deleted/disabled with it
```

The manifest is generated server-side from the agent (name, avatar-derived
display name) and `PUBLIC_APP_URL` + `/api/bridges/slack/<id>`; scopes and
events exactly as the bridge needs: `app_mentions:read, channels:history,
channels:read, channels:join, groups:history, groups:read, chat:write,
files:read, files:write, users:read`; events `app_mention, message.channels,
message.groups`; socket mode off.

## Wizard UX (agent settings)

Three steps, one panel, state derived from the row's status:

1. **Create** — "Connect this agent to Slack" → creates the draft, shows the
   manifest in a copy-to-clipboard block (`navigator.clipboard.writeText`)
   with the exact click-path: api.slack.com/apps → Create New App → From a
   manifest → pick workspace → paste → Create → Install to Workspace. Notes
   that the request URL will verify automatically.
2. **Connect** — two fields (Bot User OAuth Token `xoxb-…`, Signing Secret)
   with copy-paste hints of where each lives (OAuth & Permissions / Basic
   Information → App Credentials). Submit → server verifies → success shows
   the Slack workspace name + bot id it connected to; failure shows Slack's
   error inline.
3. **Done** — status card (team, bot, active); next steps: `/invite @bot`
   in the Slack channels you want, then bridge a channel from channel
   settings. Disconnect lives here too.

Channel-settings bridging UI changes from "uses the global Slack app" to
picking one of the workspace's connected agents (apps).

## What is deliberately out

- Slack OAuth "Add to Slack" install flow (tokens by redirect instead of
  paste). The manifest+paste wizard is the ask; OAuth needs a public app +
  client secret handling and buys nothing at a-couple-of-bots scale.
- Multiple Slack workspaces per app row (an app is installed where it's
  installed — `auth.test`'s team is recorded, that's it).
- Per-bridge agent overrides, DM (`message.im`) bridging, token rotation.

## Phases

### Phase A — backend

Schema + migration (0015), crypto extraction, `slack_apps` service
(create-draft / manifest builder / verify-and-store via `auth.test` /
views with a no-token serialization test / delete), per-app events route with
draft `url_verification` policy + per-row signature verification, ownership
filter, adapter/mirror/ingest through the bridge's app (client per app,
`authorName` → null for the app's own agent), removal of `readSlackConfig`,
env types, `slackSurfaceStatus` and the old route. Wizard API endpoints.
Tests: per-app signature accept/reject, draft handshake, ownership drop,
cross-workspace 404s (IDOR suite extension), auth.test success/failure paths,
serialization leak sweep for tokens.

*Verify:* `bun test`, typecheck, lint; a scripted end-to-end against a fake
Slack API (repo test idiom) covering draft → tokens → event → ingest →
mirror.

### Phase B — frontend wizard

The three-step panel in the agent settings UI, clipboard copy, inline
guidance, token form + error surfacing, status card, disconnect, channel
bridging UI updated to pick a connected agent. Unit tests for any new pure
logic; boot-probe acceptance via dev login (create draft for an agent, see
manifest, paste dummy tokens → see the verification error surface properly).

**Done.** The wizard is a fourth section in the agent settings dialog
(`components/workspace/agent-slack-panel.tsx`), with the step derived from the
row's status in `lib/slack-wizard.ts` (unit-tested), so closing the dialog mid
setup resumes rather than restarts. Disconnect confirms inline, not in a
`ConfirmDialog`: React reports a nested `<dialog>`'s close on the outer one too,
which shut the whole settings dialog as soon as the confirmation was answered.

Boot-probe acceptance (dev login, local dev server, screenshots in
`docs/acceptance/slack-apps/`):

- `01` step 1 → `02` draft created: manifest, click-path and Copy button
- `03` fake tokens → Slack's own `invalid_auth` inline under the form, both
  fields kept for the retry (real `auth.test` call; no workspace was touched)
- `04` reopened: manifest folded, `lastError` shown, "tokens keep working"
- `05` channel settings with nothing connected: "Connect an agent to Slack first"
- `06`–`08` connected app (row forced to `active` locally, since a real token
  needs a real Slack workspace): rail line, done card, bridge picker offering
  the connected agent
- `09`–`10` disconnect confirm → back to step 1, row gone from D1

### Phase C — ship

Progress entry (cycle 9), commits per phase, `bun run prod:deploy`, delete
the now-unused `SLACK_BOT_TOKEN`/`SLACK_SIGNING_SECRET` prod secrets, live
smoke check of `/api/bridges/slack/:id` handshake behaviour.
