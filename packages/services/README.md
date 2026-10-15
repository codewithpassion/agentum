# @repo/services

The service layer: business rules and input validation, on top of the query functions in [`@repo/db`](../db). The web app calls it through tRPC (`apps/web/src/server/trpc/`), but nothing here knows about tRPC, Hono or Cloudflare. A script or a test can use a service the same way.

## Entry points

None yet. This package has no services. The `exports` map is empty, so nothing can be imported from it until a module is added.

One entry per module, no barrel file, same as `@repo/db`. Everything here is server-only: services import drizzle-backed modules.

## Using it

A service is a factory that takes a drizzle instance. A new module would be used like this (`createXService` is a placeholder):

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

The package has no `test` or `typecheck` script while `src/` is empty, because `bun test` and `tsc` both fail when they find no files. The first service adds `"test": "bun test"` and `"typecheck": "tsc --noEmit"` to `package.json`.
