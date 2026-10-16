# DB.1 review

## Verdicts

- Round 1 (2989174): clean. The reviewer found no must-fix items. It checked that both `events` triggers survived, that nothing else hand-written existed in the 16 old files, and that no old migration file name is left outside historical docs.

## Schema comparison

I built one SQLite database from the 16 old files (`0000_notes` to `0015`, from `f4b5f06`) and one from `0000_init.sql`, then dumped both from `sqlite_master` and the table pragmas, normalised (quotes and whitespace stripped, columns sorted by name). The dumps are identical: the same 21 tables with the same columns, types, NOT NULL flags, defaults, primary keys and foreign keys with their ON DELETE actions, the same 24 indexes, and the same two triggers (`events_no_update`, `events_no_delete`). The `notes` table is in neither.

One difference remains, which the sorted comparison hides. `machine_enroll_tokens.created_by`, `runs.pending_attempts`, `runs.swept_at` and `sessions.private` were added by ALTER TABLE in the old chain, so they sat last in their tables. In `0000_init.sql` they are in alphabetical position. Nothing in the repo uses `SELECT *` or an INSERT without a column list, so it does not matter.

Other checks: `ls packages/db/migrations` shows `0000_init.sql` and `meta/`, with one snapshot and a one-entry journal. `bun run generate` right after gives "No schema changes". `wrangler d1 migrations apply DB --local` on a fresh local database applies one migration (48 commands) with no errors. `packages/db/src/events.test.ts` shows UPDATE and DELETE on `events` are refused under the single migration. `bun run e2e:sessions` and `bun run e2e:log` pass against a dev server on this worktree's own local database.

## Nits left

- `packages/db/README.md` says how to reset a local database but not what to do about a remote D1 that already listed `0000_notes`.
- Historical review docs (`docs/reviews/tasks/F.1.md`, `docs/reviews/tasks/M0.2.md`, `docs/reviews/M0-2.md`, `docs/reviews/M3-1.md`) still name old migration files. They record what happened then.
- `packages/db/README.md` still calls `triggers` a stub that M4.1 replaces. This was stale before DB.1.
- `docs/HANDOVER.md` never named a migration file, so it has no change.
- After `bun run generate`, Biome has to reformat `migrations/meta/*.json` before `bun run check` passes. This was already true before DB.1.

## Steps for Dom

- Local databases: delete `apps/web/.wrangler/state/v3/d1` and run `bunx wrangler d1 migrations apply DB --local` in `apps/web`.
- First remote apply: if any remote D1 database (production or staging) already ran `0000_notes` and the older files, it lists those names and will also run `0000_init`, which fails on existing tables. Per the task nothing has been deployed with this schema, so use a new or emptied database. Otherwise drop its tables and the `d1_migrations` rows first.
