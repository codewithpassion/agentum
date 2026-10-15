# @repo/services

The service layer: business rules and input validation, on top of the query functions in [`@repo/db`](../db). The web app calls it through tRPC (`apps/web/src/server/trpc/`), but nothing here knows about tRPC, Hono or Cloudflare. A script or a test can use a service the same way.

## Entry points

| Import | Contents |
| --- | --- |
| `@repo/services/crypto` | `SecretBinding`, `importSecretsKey`, `encryptSecret`, `decryptSecret` (AES-GCM under `SECRETS_KEY`, bound to workspace, table, row and field), and `hashedToken`, `hashToken`, `tokenMatchesHash` for tokens a table stores only as a SHA-256 hash |
| `@repo/services/run-tokens` | `importRunTokenKey`, `signRunToken`, `verifyRunToken`: `hm_run_` tokens signed with HMAC under `RUN_TOKEN_KEY`, valid for 12 hours and only while the run is `running` on a live lease |
| `@repo/services/events` | `createEventsService({ db, blobs })`, the event input and filter schemas |

One entry per module, no barrel file, same as `@repo/db`. Everything here is server-only: services import drizzle-backed modules.

### Events

`append(event)` validates, strips secrets, and writes one row. A payload over 64 KB goes to `blobs.put` under `payloads/<workspaceId>/<eventId>.json`, and the row keeps `{}` as its payload and the key in `payload_ref`. `blobs` is `{ get, put }`: R2 in the app, a `Map` in tests. `transcript(sessionId)` returns the `message.*` and `tool.*` events of a session ordered by id, and the caller has already checked the session's workspace. `query(workspaceId, filters)` filters by agent, run, session, types and an `after` id cursor. `readPayload(event)` fetches an overflowed payload. The event types and actor kinds are in `@repo/db/shared`. The helpers in `src/events/` (ids, payload cap, redaction) are copies from control-plane.

## Using it

A service is a factory that takes a drizzle instance. A service that writes more than one row also takes `atomic` from `@repo/db/atomic`, as `{ db, atomic }`. A new module would be used like this (`createXService` is a placeholder):

```ts
import { createXService } from "@repo/services/x";
import { drizzle } from "drizzle-orm/d1";

const x = createXService(drizzle(env.DB));
await x.list();
```

In the app, `apps/web/src/server/trpc/context.ts` builds the services once per call and puts them on `ctx.services`.

## Writing a service

Add a module as `src/x.ts` and an entry for it in `exports`. Then follow these rules:

- Export the input schema (zod). The tRPC router passes it to `.input()`, and the service parses with it again, so a caller that skips tRPC still gets validated input.
- Methods are `async`, so a validation error rejects the promise rather than throwing synchronously.
- Take a `Database` from `@repo/db`. Never read `env`, bindings or the request; the caller passes in what the service needs, including the user id when a rule depends on it.
- Return the plain JSON shapes from `@repo/db/shared`.

A new service also needs a line in `apps/web/src/server/trpc/context.ts` and in the add-clerk skill's copy of that file (`.claude/skills/add-clerk/templates/apps/web/src/server/trpc/context.ts`).

## Scripts

`bun test` and `bun run typecheck`. Tests that need a database import `migrated` from `@repo/db/test-db`, an in-memory SQLite with the real migrations.
