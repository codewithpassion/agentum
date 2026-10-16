# @repo/services

The service layer: business rules and input validation, on top of the query functions in [`@repo/db`](../db). The web app calls it through tRPC (`apps/web/src/server/trpc/`, where `workspaceProcedure` admits a signed-in user in an allowed workspace). The bearer-authenticated Hono routes (`/mcp`, `/api/proxy`, and the machine, Slack, trigger and file routes) resolve a principal with `createPrincipalResolver` and call services directly. They are the one exception to "the app reaches it only through tRPC". Nothing here knows about tRPC, Hono or Cloudflare, so a script or a test can use a service the same way.

## Entry points

| Import | Contents |
| --- | --- |
| `@repo/services/crypto` | `SecretBinding`, `importSecretsKey`, `encryptSecret`, `decryptSecret` (AES-GCM under `SECRETS_KEY`, bound to workspace, table, row and field), and `hashedToken`, `hashToken`, `tokenMatchesHash` for tokens a table stores only as a SHA-256 hash |
| `@repo/services/run-tokens` | `importRunTokenKey`, `signRunToken`, `verifyRunToken`: `hm_run_` tokens signed with HMAC under `RUN_TOKEN_KEY`, valid for 12 hours and only while the run is `running` on a live lease |
| `@repo/services/authz` | `can(principal, action, resource)`, `authorize` (throws `ForbiddenError`), `isForbiddenError`. In v1 a principal acts only inside its own workspace, and the `system` principal (the tick) passes |
| `@repo/services/workspaces` | The `Principal` union, `createWorkspacesService({ allowedOrgIds, db })` (`forOrg`, `sessionPrincipal`), and `createPrincipalResolver` for bearer tokens |
| `@repo/services/agents` | `createAgentsService({ db, events })` (`create`, `get`, `list`, `update`, `archive`), the slug rules, `findAgent` |
| `@repo/services/errors` | `ServiceError` (`conflict` 409, `invalid` 400, `not_found` 404), `isUniqueViolation` |
| `@repo/services/runs` | `createRunsService({ db, atomic, adapters, gateways, blobs, clock, devFakeRuntime, runTokenKey? })`: `startRun`, `waitForRun`, `getRun`, `cancelRun`, `claimRun` (system only), `claimRunForMachine` (a daemon's claim, mints the run token with `runTokenKey`), `heartbeatRun`, `ingestRunEvents`, `completeRun`, and the two tick jobs `sweepQueuedRuns` and `reapExpiredLeases`. Its types (`RuntimeAdapter`, `Gateway`, `StartRunInput`, `Clock`) are in `@repo/services/runs/types` |
| `@repo/services/sessions` | `createSessionsService({ db, events })`: `list(principal, { agentId })` (newest first, with the first message as title and the latest run's status) and `transcript(principal, sessionId)` (the `message.*` and `tool.*` events plus the latest run). A `ui` session is visible only to the user who opened it |
| `@repo/services/files` | `createFilesService({ db, blobs })`: `upload(principal, { body, mime, name })` (a user, or a run which stamps `run_id`; 50 MB cap; the bytes go to `blobs` under `<workspaceId>/files/<id>`), `download(principal, fileId)` (a user of the workspace, or a run whose `input_file_ids` or `output_file_ids` list the id; every refusal is `not_found`) and `describe(principal, fileIds)` (a user, for the chat chips). `FileBlobs` is `{ get, put, delete }`: R2 in the app, `memoryFileBlobs()` from `@repo/services/files/memory` in tests. The routes are `POST /api/files` and `GET /files/:id` in `apps/web/src/server/routes/files.ts` |
| `@repo/services/slack` | `createSlackService({ atomic, clock, db, directory, events, fetch, runs, secretsKey })`: `receive({ rawBody, signature, timestamp })` is everything `POST /api/slack/events` does before it answers. It echoes the URL check, finds the `slack_apps` row by `api_app_id`, checks the signature with the app's signing secret and that `team_id` matches the row, then turns a DM or an app mention into `startRun` with `origin: "slack"`, session key `team:channel:threadTs` and a `{ kind: "user", via: "slack" }` principal from `identity_links`. The `slack_events_seen` row, the run and a `slack.received` event land in one atomic write, and a Slack file goes into `pending_files`. A sender with no link gets the dedupe row and a `slack.unlinked_sender` event instead. `receive` returns an `after` job for the route's `waitUntil`: the file download (`runs.fetchPendingFiles`, finished by the tick if it is lost) or the email lookup that links an org member. `purgeSeen()` trims old dedupe rows. `createSlackGateway` in `@repo/services/slack/gateway` posts the answer in the thread with retry, sends a Connect link only to the requester as an ephemeral message, and downloads pending files into `files` with `source: "slack"`. `@repo/services/slack/apps` reads the encrypted app secrets and `@repo/services/slack/signature` signs and verifies requests. The route is in `apps/web/src/server/routes/slack.ts` |
| `@repo/services/events` | `createEventsService({ db, blobs })`, the event input and filter schemas |
| `@repo/services/routines` | `createRoutinesService({ db, clock, events, runs })`: `create`, `list`, `setEnabled`, `remove` for a signed-in user, and the two tick jobs `fireDue` and `settleRuns`. A routine is a `triggers` row of kind `routine`. `@repo/services/routines/cron` has `parseCron`, `validateCron`, `isValidTimeZone` and `nextFireTime(cron, timezone, after)`, which is pure and runs on `Intl` only |

One entry per module, no barrel file, same as `@repo/db`. Everything here is server-only: services import drizzle-backed modules.

### Events

`append(event)` validates, strips secrets, and writes one row. A payload over 64 KB goes to `blobs.put` under `payloads/<workspaceId>/<eventId>.json`, and the row keeps `{}` as its payload and the key in `payload_ref`. `blobs` is `{ get, put }`: R2 in the app, a `Map` in tests. The three reads take the calling principal first and call `authorize`: `transcript(principal, workspaceId, sessionId)` returns the `message.*` and `tool.*` events of a session ordered by id, `query(principal, workspaceId, filters)` filters by agent, run, session, types and an `after` id cursor, and `readPayload(principal, event)` fetches an overflowed payload. The event types and actor kinds are in `@repo/db/shared`. The helpers in `src/events/` (ids, payload cap, redaction) are copies from control-plane.

### Runs

`startRun(principal, input)` takes no actor: the actor and `on_behalf_of_user_id` come from the principal. A user acts for themselves, a run principal acts as its agent for the user its parent run was for (`parent_run_id` and `depth` follow, and depth above 3 is refused), a trigger acts for nobody, and only the `system` principal (the tick) may start a run for any agent. The session is found or created on `(agent, origin, externalKey)`; without a key the session's own id is its key, so the UI sends the next message with the id it got back. The run is inserted with its session in one `atomic` write. A third argument, `{ alongside?, pendingFiles? }`, is for trusted callers inside the Worker (the Slack service): `alongside({ runId, sessionId })` returns more statements for the same atomic write, and `pendingFiles` stores file descriptors, which keep the run from being claimed or offered until `fetchPendingFiles` has stored them. A duplicate `requestId` fails the unique index and the first run is returned. Then `run.queued` and `message.user` are appended and the agent's `RuntimeAdapter` (`adapters`, keyed by `agents.runtime`) gets the run in `dispatch`. `FakeRuntime`, which echoes the input, is registered only when `devFakeRuntime` is true, and is the one adapter that finishes the run inside `dispatch`.

`ingestRunEvents` and `completeRun` answer 409 (`ServiceError` `conflict`) unless the run is `running`, so a late call from an execution whose lease expired writes nothing. The one exception is `completeRun({ status: "aborted" })`. On a `running` run it makes the run `interrupted` with `process_ended_at` set and appends `run.interrupted`; on an `interrupted` run it records `process_ended_at`. A repeat gets 409. Only the `system` principal and the machine that claimed the run may call them. `completeRun` hands the reply target to the `Gateway` for its kind with the trusted `{ runId, agentId, onBehalfOfUserId }`; the `none` gateway is always registered. A gateway error reaches the caller after the run is saved as `done`.

The tick calls `sweepQueuedRuns(SYSTEM_PRINCIPAL)`, which offers again every run that has been `queued` or `offered` for over 60 seconds (after the reply gateway's `downloadPendingFiles` fetched leftover `pending_files`; the third failed download of a run fails it with a `run.failed` event, and `fetchPendingFiles(SYSTEM_PRINCIPAL, runId)` is the same step for one run), and `reapExpiredLeases(SYSTEM_PRINCIPAL)`, which makes a run with an expired lease `interrupted`. An interrupted run is never queued again.

`bun scripts/dev/seed-fake-agent.ts` seeds the local D1 database with a fake-runtime agent in the dev workspace and prints its id.

### Routines

A routine is a `triggers` row of kind `routine` with a cron, a timezone (the workspace's unless given), a prompt and `next_run_at`, the next slot as an ISO instant. `fireDue(SYSTEM_PRINCIPAL)` takes every enabled routine whose slot has passed, oldest first, and calls `runs.startRun` with `requestId = trigger:<id>:<slot>` and one `alongside` statement, `UPDATE triggers SET next_run_at = <next> WHERE id = ? AND next_run_at = <slot>`. The run and the update land in one `atomic` write, and the run is dispatched afterwards. An overlapping tick hits the unique `request_id`, so its whole write is undone and it reads the first run back without dispatching. A write that fails leaves `next_run_at` at the slot, so the next tick fires it, and counts one error. A run left `queued` by a crash after the write is offered by `sweepQueuedRuns`. Slots missed while the tick was down collapse into one run, and the next slot is the first one after now.

`consecutive_errors` counts failed writes and runs that ended `failed` or `interrupted` (`settleRuns` reads each routine's runs, `runs.actor_id` being the routine id, in order from `settled_run_id`, up to the first one still running, so every run is counted once). The fifth in a row sets `disabled_at`, and a `done` run resets the count. `setEnabled(true)` clears the count and picks the next slot after now.

`nextFireTime` runs a job whose hour field is `*` in real time. Any other job runs on the wall clock: in the repeated hour of a fall-back it fires once, in the first pass, and a wall time inside a spring-forward gap fires once when the gap ends. The upstream bruce-next copy skipped the gap and fired twice in the repeat.

### Workspaces and principals

A workspace is one Clerk organisation, created on its first request by `forOrg`. An org outside `allowedOrgIds` has no workspace. `sessionPrincipal({ orgId, userId })` turns a Clerk session into a `user` principal (`via: "session"`).

`createPrincipalResolver({ db, runTokenKey, verifyClerkOAuthToken, isOrgMember, allowedOrgIds })` has one method, `resolve(authorization)`, which returns a `Principal` or null (answer 401). The token prefix picks the check: `hm_run_` run token, `hm_mach_` machine credential (`machines.credential_hash`, not revoked), `hm_trg_` trigger token (`triggers.token_hash`; routines have no token), `hm_key_` API key (`api_keys.key_hash`, a stub table that M2.1 builds on), and a token with no `hm_` prefix goes to `verifyClerkOAuthToken`. Any other `hm_` token is refused. Every accepted token must belong to a workspace whose org is in `allowedOrgIds`. The `api_key` and `oauth` principals also pass `isOrgMember(userId, clerkOrgId)`, whose answer, true or false, is reused for 60 seconds per user and org. A throw from `isOrgMember` or `verifyClerkOAuthToken` is not caught, so a Clerk outage is a 5xx, not a 401. `SYSTEM_PRINCIPAL` is for the minute tick; nothing resolves to it from a request.

## Using it

A service is a factory that takes one object, `{ db, atomic, ... }`, and never `env`. `db` is a drizzle instance. A service that writes more than one row also takes `atomic` from `@repo/db/atomic`, and the others take what they need from the caller, such as `blobs`, `clock` or `adapters`. A new module would be used like this (`createXService` is a placeholder):

```ts
import { d1Atomic } from "@repo/db/atomic";
import { createXService } from "@repo/services/x";
import { drizzle } from "drizzle-orm/d1";

const db = drizzle(env.DB);
const x = createXService({ atomic: d1Atomic(db), db });
await x.list(principal);
```

In the app, `compose` in `apps/web/src/server/compose.ts` builds the services from the Worker's bindings, once per request and once per minute tick. `apps/web/src/server/trpc/context.ts` puts them on `ctx.services`, and the bearer routes read them from the same composed object.

## Writing a service

Add a module as `src/x.ts` and an entry for it in `exports`. Then follow these rules:

- Export the input schema (zod). The tRPC router passes it to `.input()`, and the service parses with it again, so a caller that skips tRPC still gets validated input.
- Methods are `async`, so a validation error rejects the promise rather than throwing synchronously.
- Take `{ db, ... }` with `db` typed as `Database` from `@repo/db`. Never read `env`, bindings or the request; the caller passes in what the service needs, including the user id when a rule depends on it.
- Rows that must land together go through the `atomic` parameter, never `db.batch` or `db.transaction`.
- Return the plain JSON shapes from `@repo/db/shared`.

A new service also needs a factory call in `composeWith` and a field on `Services` in `apps/web/src/server/compose.ts`.

## Scripts

`bun test` and `bun run typecheck`. Tests that need a database import `migrated` from `@repo/db/test-db`, an in-memory SQLite with the real migrations.
