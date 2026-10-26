# X.1 review: Harbourmaster on the shared production Clerk instance

## What changed

Two one-off scripts in `apps/web/scripts`, both run from `apps/web`:

- `bun run migrate-clerk-ids --map <file> (--db <sqlite file> | --d1 DB [--remote] [--env staging]) [--apply] [--invert]` rewrites every Clerk org and user id in the database. Without `--apply` it writes nothing and prints every cell it would change, then any id it has no mapping for. `--invert` swaps the mapping, which is the data rollback.
- `bun run build-clerk-id-map --db <sqlite file> --out <file>` writes the mapping. Users are matched by email (dev instance email, then the same email on the production instance), organisations by name. It needs the dev key (`CLERK_SECRET_KEY` in `.env.local`) and the production key (`CLERK_SECRET_KEY` in `.env.production.local`, or `CLERK_PROD_SECRET_KEY`). It only reads from Clerk and from the database. It exits 1 and lists what it could not resolve; the file still holds the rest.

The migration script does not keep a column list. It reads the schema, scans every text column for `user_...` and `org_...` tokens, and rewrites each mapped token with `REPLACE`. That covers `workspaces.clerk_org_id`, every `created_by`, `author_id`, `actor_id` and `on_behalf_of_user_id` style column, ids inside event payload JSON, and `workspaces.name` (which holds the org id). A token with no mapping is listed as `UNMAPPED` and blocks `--apply`. Two workspaces for one org (a stray empty workspace for the new org id) also block it. `events` is append-only through two triggers, so the script drops them before the `events` update and recreates them after it, inside one SQLite transaction on a file. On D1 it writes a statement file with `wrangler d1 execute --file`, then reads the database again and fails unless no mapped id is left and both triggers exist. A second run is safe: it finds nothing to change, and it restores the triggers if a failed write lost them.

`agent-login --env staging` now uses the production key, because staging moves to the production instance. Local and preview keep the dev key. CLAUDE.md says so.

The mapping file shape:

```json
{
  "orgs": { "org_<dev id>": { "id": "org_<prod id>", "name": "optional note" } },
  "users": { "user_<dev id>": { "id": "user_<prod id>", "email": "optional note" } },
  "ignore": ["user_<an id from another system>"]
}
```

A plain string works in place of the object. Only `id` is read. `ignore` is optional: ids that look like Clerk ids but belong to something else, such as the-brain's user id inside stored tool output. Both scripts leave them alone, and the dry run counts them. A mapped id can't also be ignored.

A Clerk id is `user_` or `org_` plus 27 base62 characters, not part of a longer identifier. Anything else that starts with `user_` or `org_` (the enum value `user_or_agent`, the path `/mcp/org_user_<id>`) is not an id and is never scanned, mapped or reported. The mapping file rejects entries that don't have that shape.

## Verdicts

Round 1 at 8e91df2: clean. The reviewer ran the dry run, an apply and an inverted apply on a copy of the production data: 27 cells listed, equal to the 27 id tokens in the raw dump, nothing written by the dry run, both triggers back, foreign key and integrity checks clean, and `--invert` restored the original exactly. The Cloudflare docs say a failed remote `d1 execute --file` returns the database to its original state.

## Dry run on the copy of production D1

The copy is `tmp/X.1/prod-d1.sql`, loaded into a local SQLite file. It holds one workspace (the Dev Workspace org `org_3KkfBN77ien6ryvH4YDBFjGNw0v`, also stored as the workspace name) and one user (`user_3Kk8S5uJZvRLPGiEoZ8ZfJfCH8m`, dev@rockyshoreslabs.io). With a sample mapping the dry run lists 27 cells in 21 rows of 9 tables (agents, events x13, files, machine_enroll_tokens, machines, runs x6, sessions, triggers, workspaces x2). Applying it to a copy and scanning every row of every table leaves 0 rows holding a dev id, and both events triggers are back. The same dry run through `wrangler d1 execute --local` on a Miniflare D1 loaded with that data gives identical output, `--apply` works there, and `--invert` puts the old ids back exactly.

The sample mapping used a placeholder user id and the Harbour Edge Intelligence org as the target, because the real targets do not exist yet (see below). Do not apply it.

Round 2 (fix for false positives found on the staging copy): pending.

## Staging copy dry run

On the staging copy (`tmp/X.1/staging.sqlite`) the old scan reported `user_or` (the enum value `user_or_agent`), `org_user` (a the-brain MCP URL) and the-brain's own user id (136 cells in stored tool output) as unmapped. With the strict id shape and the-brain's id in `ignore`, the dry run lists 926 cells in 769 rows of 20 tables, 136 ignored, nothing unmapped, exit 0. Applying it to a copy and running the dry run again gives 0 cells to change. The dry run left the file byte-identical.

## Nits left

Fixed after the review: a mistyped `--db` path now fails instead of creating an empty database, and the "triggers missing" message says how to recreate them.

Left:

- `REPLACE` has no token boundary, so an old id inside a longer string would also change. Clerk ids have one length, so it can't happen with real ids.
- The clash check before `--apply` covers only `workspaces.clerk_org_id`. A unique index that includes a user id (`credentials_owner_unique`) could clash if both the old and the new user own a credential. On D1 the write fails whole and nothing changes.
- A re-run with no id left to change does not recreate missing events triggers. It only happens after a failed write on a database that doesn't roll back.
- The statement file for D1 goes to a fixed name in `$TMPDIR` or `/tmp`.
- `build-clerk-id-map` reports a Clerk auth, network or rate-limit error as "not found on the dev instance", and sends all lookups at once. Both end in unresolved ids and exit 1.
- `agent-login` doesn't check that the staging or production key starts with `sk_live_`.

## Ideas beyond the scope

- Previews will break sign-in after the cutover. `preview:deploy` builds through `staging:build`, and a Vite production build reads `VITE_CLERK_PUBLISHABLE_KEY` from `.env.production.local`, so the preview client bundle would carry the live key while the preview Worker's base-config secrets still hold the dev keys. A live key does not work on `*.workers.dev`. The preview build needs the dev publishable key passed in the environment (process env beats the `.env` files). Left alone because previews are not part of this task.
- Event payloads moved to R2 (`payload_ref`) are not scanned. The production copy has none.
- `oauth_clients` has no rows in the production copy, so nothing to report there. The script maps `first_seen_by` like any other column but does not touch approvals.

## Steps for Dom

The mapping cannot be finished yet. Production D1 holds the data of the Dev Workspace org (`org_3KkfBN77ien6ryvH4YDBFjGNw0v`) and the user dev@rockyshoreslabs.io. The production Clerk instance (`ins_3LDH0LvG5SOMvxgdBIX2kyIj1Sf`) has neither: it has only Harbour Edge Intelligence (`org_3LDLbiYGe7iohEccrRQuLeBqaX2`) and the three Dominik users. Pick one before the cutover:

1. Create a "Dev Workspace" org and a dev@rockyshoreslabs.io user on the production instance. The mapping then resolves by itself and the data (V0.2 smoke-test agent, runs and events) stays in its own workspace.
2. Map the Dev Workspace to Harbour Edge Intelligence and the dev user to a Dominik user, by editing the mapping file by hand. The smoke-test data then sits in the HEI workspace.

If the dev instance org "Harbour Edge Intelligence" (`org_3KnFka85ToHWHruOoQiwz0QGBkS`) has no workspace in the database, nothing needs mapping for it. It only needs to be replaced in `ALLOWED_ORG_IDS`.

Cutover, staging first. Run the commands from `apps/web`. Between the D1 step and the deploy nobody uses the app: a request from the old instance after the rewrite would create a stray workspace, and the script would then refuse to run until it is deleted.

1. Save the old values so each step can be undone: `VITE_CLERK_PUBLISHABLE_KEY`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` (the dev values now in `.env.production.local`) and the current `ALLOWED_ORG_IDS` secret, into a file outside the repo, for example `~/.config/harbourmaster/rollback-clerk.env` (mode 600). Worker secrets can't be read back, so the secret values come from the file and from the Clerk dev dashboard.
2. Export the database: `bunx wrangler d1 export DB --remote --env staging --output ../../../tmp/staging.sql` (same without `--env staging` for production). Load it into a SQLite file: `bun -e 'import {Database} from "bun:sqlite"; import {readFileSync} from "fs"; new Database("../../../tmp/staging.sqlite",{create:true}).exec(readFileSync("../../../tmp/staging.sql","utf8"))'`.
3. Build and read the mapping: `bun run build-clerk-id-map --db ../../../tmp/staging.sqlite --out ../../../tmp/staging-map.json`. Fix anything it lists as `UNRESOLVED` by hand. An id that belongs to another system goes in the file's `ignore` list: add it by hand and re-run (the builder keeps the list and skips those ids), or pass `--ignore-unresolved` to put everything it could not resolve there, after checking the list it printed. Staging and production each need their own run, because their data differs.
4. Dry run on the copy, then on the real database: `bun run migrate-clerk-ids --map ../../../tmp/staging-map.json --db ../../../tmp/staging.sqlite`, then `bun run migrate-clerk-ids --map ../../../tmp/staging-map.json --d1 DB --remote --env staging`. Both must exit 0 with no `UNMAPPED` or `PROBLEM` lines.
5. Note a D1 Time Travel bookmark: `bunx wrangler d1 time-travel info DB --env staging`.
6. Put the production keys into `apps/web/.env.production.local` (`VITE_CLERK_PUBLISHABLE_KEY` and `CLERK_PUBLISHABLE_KEY` as `pk_live_...`, `CLERK_SECRET_KEY` as `sk_live_...`). The publishable and secret key must change together: the MCP OAuth metadata takes its issuer from the publishable key. `VITE_CLERK_PUBLISHABLE_KEY` is read at build time, so a `wrangler secret put` alone leaves the old key in the client bundle.
7. Apply to staging D1 and deploy at once: `bun run migrate-clerk-ids --map ../../../tmp/staging-map.json --d1 DB --remote --env staging --apply`, then `wrangler secret put CLERK_SECRET_KEY --env staging`, the same for `CLERK_PUBLISHABLE_KEY` and `ALLOWED_ORG_IDS` (the production org ids, comma separated, no spaces), then `bun run staging:deploy`.
8. Check staging: `bun run agent-login --env staging --email <a user on the production instance>`, open the URL in a fresh browser session, and confirm the app loads in the mapped workspace with its old agents and sessions. Re-run the dry run with `--d1 DB --remote --env staging`: it must list 0 cells.
9. Production, same steps with the production export and `bun run deploy`, and no `--env`.
10. After production works, update the "Production runs on the Clerk dev instance" line in `docs/HANDOVER.md`.

Rollback for one environment:

1. Data: `bun run migrate-clerk-ids --map <the same file> --d1 DB --remote [--env staging] --apply --invert`. It refuses if a user who signed up on the production instance in the meantime owns rows (an `UNMAPPED` id); then use `bunx wrangler d1 time-travel restore DB --bookmark <bookmark from step 5> [--env staging]` instead, which also drops anything written since.
2. Secrets: `wrangler secret put` the three old values (`CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `ALLOWED_ORG_IDS`) from the saved file.
3. Restore the old values in `apps/web/.env.production.local` and redeploy (`bun run staging:deploy` or `bun run deploy`).

After the cutover every user signs in again, and every OAuth MCP client approved against the dev instance must be approved again: the client ids belong to the old instance. Each person reconnects their MCP client, then a workspace member approves it in the app. The production copy has no `oauth_clients` rows. Staging may have some.
