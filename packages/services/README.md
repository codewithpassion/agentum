# @repo/services

The service layer: business rules and input validation, on top of the query functions in [`@repo/db`](../db). The web app calls it through tRPC (`apps/web/src/server/trpc/`), but nothing here knows about tRPC, Hono or Cloudflare. A script or a test can use a service the same way.

## Entry points

| Import | Contents |
| --- | --- |
| `@repo/services/notes` | `createNotesService`, `createNoteInput` (zod schema), `NotesService`, `CreateNoteInput` |

One entry per module, no barrel file, same as `@repo/db`. Everything here is server-only: services import drizzle-backed modules.

## Using it

A service is a factory that takes a drizzle instance:

```ts
import { createNotesService } from "@repo/services/notes";
import { drizzle } from "drizzle-orm/d1";

const notes = createNotesService(drizzle(env.DB));
await notes.create({ text: "  hello  " }); // stored as "hello"
await notes.list();
```

In the app, `apps/web/src/server/trpc/context.ts` builds the services once per call and puts them on `ctx.services`.

## Writing a service

`src/notes.ts` is the template:

- Export the input schema (zod). The tRPC router passes it to `.input()`, and the service parses with it again, so a caller that skips tRPC still gets validated input.
- Methods are `async`, so a validation error rejects the promise rather than throwing synchronously.
- Take a `Database` from `@repo/db`. Never read `env`, bindings or the request; the caller passes in what the service needs, including the user id when a rule depends on it.
- Return the plain JSON shapes from `@repo/db/shared`.

A new service also needs a line in `apps/web/src/server/trpc/context.ts` and in the add-clerk skill's copy of that file (`.claude/skills/add-clerk/templates/apps/web/src/server/trpc/context.ts`).

## Tests

```bash
bun test
```

Like `@repo/db`, each test gets a fresh in-memory `bun:sqlite` database with the real migrations applied, so the tests cover the service, the queries and the schema together.
