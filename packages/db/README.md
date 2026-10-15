# @repo/db

The database layer of the monorepo: a [Drizzle](https://orm.drizzle.team) schema for [Cloudflare D1](https://developers.cloudflare.com/d1/), the generated migrations, and the `atomic` write port.

## Entry points

| Import | Contents | Where it may run |
| --- | --- | --- |
| `@repo/db` | the `Database` type | Anywhere (type only) |
| `@repo/db/schema/<module>` | the tables of one module, e.g. `@repo/db/schema/runs` | Server only: it imports drizzle |
| `@repo/db/atomic` | `d1Atomic`, `sqliteAtomic`, the `Atomic` and `Statement` types | Server only |
| `@repo/db/shared` | enum values (`RUN_STATUSES`, `EVENT_TYPES` and friends) and their types | Anywhere, including React components |
| `@repo/db/test-db` | `migrated()`, an in-memory `bun:sqlite` database with all migrations applied | Tests only |

One entry per module, no barrel file. A new lane adds `src/schema/<module>.ts` (picked up by the glob in `drizzle.config.ts` and by the `@repo/db/schema/*` export) and, for its query functions, a `src/<module>.ts` with its own `exports` line. Keep the server/browser split. Importing a drizzle-backed entry from a route component pulls drizzle into the browser bundle. Anything the UI needs goes in `src/shared.ts`.

## The tables

The nine foundation tables are `workspaces`, `identity_links`, `agents`, `machines`, `machine_enroll_tokens`, `sessions`, `runs`, `events` and `files`, grouped into `src/schema/` modules by area. Ids are ULIDs as text, timestamps are ISO text, JSON columns are text. Every table except `workspaces` has `workspace_id TEXT NOT NULL` with no default, so a forgotten scope fails at insert; `src/columns.ts` holds the shared builder. `events` is append-only: its migration ends with `BEFORE UPDATE` and `BEFORE DELETE` triggers that abort. drizzle-kit does not emit triggers, so they are hand-written at the end of `migrations/0002_foundation.sql`. Keep them there if you regenerate that migration.

## Query functions

Query functions take a drizzle instance rather than making one, so the same code runs against D1 on the Worker and against `bun:sqlite` in the tests. The parameter type is `Database` from `@repo/db`, which is any drizzle SQLite instance, sync or async. This package never reads environment variables or bindings. Return plain JSON shapes, not row types, and leave validation to the service in `@repo/services`.

```ts
import { drizzle } from "drizzle-orm/d1";

const db = drizzle(env.DB); // cheap, nothing to cache between requests
```

## Writing more than one row: `atomic`

Any write that must succeed or fail as a whole goes through `atomic`. Never call `db.batch` or `db.transaction` directly, and never run two writes in a row and hope.

drizzle 0.44 has `batch` only on the D1 driver and interactive transactions only on the SQLite drivers, and D1 has no interactive transactions at all. So `@repo/db/atomic` has one type, `Atomic`, and two adapters: `d1Atomic(drizzle(env.DB))` runs one `db.batch`, and `sqliteAtomic(db)` runs one `db.transaction` on `bun:sqlite`. The app builds the D1 one, tests build the SQLite one, and services take an `atomic` parameter next to `db`.

```ts
await atomic([
  db.insert(runs).values(run),
  db.insert(events).values(queuedEvent),
]);
```

Pass unexecuted insert, update or delete builders. Do not `await` them or call `.run()`. Pass writes only. A select would type-check, but its rows are discarded, so a read that decides the write has to happen before the call and be guarded in the write itself (`WHERE status = ?`).

## Schema and migrations

`src/schema/*.ts` defines the tables. After changing it, generate a migration:

```bash
bun run generate            # drizzle-kit generate, writes migrations/
```

Migrations are applied by wrangler, not by drizzle-kit. `apps/web/wrangler.jsonc` points its `migrations_dir` at `migrations/` here, so from `apps/web`:

```bash
wrangler d1 migrations apply DB --local     # the local miniflare database
wrangler d1 migrations apply DB --remote    # the real D1 database
```

`bun run dev` in `apps/web` (and at the repo root) runs the `--local` one before starting the dev server, so a fresh clone has an up-to-date local database.

Commit `migrations/`, including `migrations/meta/`. Drizzle diffs the schema against the snapshot in there, so without it the next `generate` would try to create the tables again.

## Tests

```bash
bun test
```

Each test gets a fresh in-memory `bun:sqlite` database with the migrations applied (`migrated()` in `src/test-db.ts`). No server, no network, and the migrations are exercised alongside the queries.
