# @repo/db

The database layer of the monorepo: a [Drizzle](https://orm.drizzle.team) schema for [Cloudflare D1](https://developers.cloudflare.com/d1/), the generated migrations, and one example table (`notes`) showing the shape every table should follow.

## Entry points

| Import | Contents | Where it may run |
| --- | --- | --- |
| `@repo/db` | the tables, the `Database` type | Server only: it imports drizzle |
| `@repo/db/notes` | `listNotes`, `createNote` | Server only, called by `@repo/services` |
| `@repo/db/shared` | `Note` type, `NOTE_TEXT_MAX_LENGTH` | Anywhere, including React components |

One entry per module, no barrel file: a new table gets its own `src/<name>.ts` and its own `exports` line in `package.json`. Keep the server/browser split. Importing a drizzle-backed entry from a route component pulls drizzle into the browser bundle. Anything the UI needs goes in `src/shared.ts`.

## Using it

The query functions take a drizzle instance rather than making one, so the same
code runs against D1 on the Worker and against `bun:sqlite` in the tests. The
app does not call them directly. It goes through [`@repo/services`](../services),
which validates input first:

```ts
import { createNote, listNotes } from "@repo/db/notes";
import { drizzle } from "drizzle-orm/d1";

const db = drizzle(env.DB);
const notes = await listNotes(db);
const note = await createNote(db, { text: "hello" });
```

`env.DB` is the D1 binding declared in `apps/web/wrangler.jsonc`; this package never reads environment variables or bindings itself. `drizzle(env.DB)` is cheap, so there is nothing to cache between requests.

### Table modules

`src/notes.ts` is the template for new tables:

- The stored row shape stays private to the module.
- Functions return plain JSON (`Note`, with `id: string` and an ISO date). tRPC serializes results as JSON, so the row types should not leak.
- No validation here. The service in `@repo/services` validates input before it reaches these functions.
- The parameter type is `Database` from `@repo/db`, which is any drizzle SQLite instance, sync or async. That is what lets the tests swap D1 for `bun:sqlite`.

## Schema and migrations

`src/schema.ts` defines the tables. After changing it, generate a migration:

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

Each test gets a fresh in-memory `bun:sqlite` database with the migrations applied (`drizzle-orm/bun-sqlite`). No server, no network, and the migrations are exercised alongside the queries.
