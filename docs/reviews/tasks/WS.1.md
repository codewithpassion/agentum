# WS.1 review

Round 1 at a299f2d: not clean, two must-fix. The skills told a fresh copy to run `add-workspace --remote`, which refuses the Clerk dev key unless it is in `apps/web/.env.production.local`. And the live-links test "a workspace whose org is no longer allowed is refused" had been deleted with nothing in its place.

Round 2 at 215a846, the fix commit only: clean. The skills and `apps/web/README.md` now say where `--remote` reads its key. A live-links test deletes the workspace row (foreign keys off) and expects a refusal with no Clerk call.

Checks on the final tree: `bun run check`, `bun run test` and `bun run build` pass, the grep of `apps/web/dist/client` for `drizzle` finds nothing, and the task's grep for `ALLOWED_ORG_IDS` and `allowedOrgIds` finds nothing. `bun scripts/e2e/a2a-two-deployments.ts` passed 6 of 6. Browser: with `apps/web/.wrangler` deleted and migrated, the "Dev login (local only)" link on `/login` landed on `/desk` in Dev Workspace.

## What changed

- A `workspaces` row admits an organisation. `forOrg` only reads, and `workspaces.create` is the only writer. The session, bearer, OAuth, machine, trigger and live-artifact paths read the row.
- OAuth finds a new client's home workspace with one `userOrgIds` Clerk call and `workspaces.firstForOrgs`, so Clerk is not asked once per workspace.
- The routines tick walks every workspace.
- `/api/dev-login` makes the dev organisation's row in dev builds. `create-dev-user` stops writing `ALLOWED_ORG_IDS`. `scripts/dev/local.ts` finds the dev org from the oldest local workspace row.
- `bun run add-workspace --org <id> --name <name> (--local | --remote [--env staging])` makes a row after checking the organisation on the right Clerk instance.
- Tests seed rows with `migrated(orgIds)` from `@repo/db/test-db` (row id `ws_<org id>`). Tests that insert their own workspace rows still call `migrated()`.
- The a2a e2e harness inserts the dev organisation's row after migrating each deployment.

## Nits left

- `CLAUDE.md` (Agent Task login), `apps/web/src/routes/index.tsx:12` and the test name at `trpc/triggers-router.test.ts:150` still say "allowed organisation".
- The new live-links test asserts only `ok === false`. `reason: "not_found"` would pin which check refuses.
- `a2a-harness.ts` gives its seeded row a random UUID id, not a ULID.
- `clerkUserOrgIds` reads the first 100 memberships only. `firstForOrgs` binds one parameter per org, and D1 allows 100 per query, so a user in about 100 organisations would break it.
- The machines and triggers `authenticate` row read can never find nothing while foreign keys are on. It stays because the task asked for the read, and its tests turn foreign keys off.

## Beyond scope

- WS.2 needs a create-workspace screen. It can call `workspaces.create` as is.
- `freshMember` in `live-artifacts/auth.ts` calls Clerk directly and has no unit test. Its row check is `sessionPrincipal`, which is tested.

## For Dom

- Before deploying to staging or production, list `workspaces` in that environment and compare it with that environment's `ALLOWED_ORG_IDS`. A row outside the list gains access when this ships, and an allowed org that never visited has no row and loses it. Add missing rows with `bun run add-workspace --org <id> --name <name> --remote [--env staging]`, then remove the Worker secret after the deploy.
- `--remote` without `--env staging` reads `CLERK_SECRET_KEY` from `apps/web/.env.production.local` or the process environment, so the production key must be in that file. `--remote --env staging` reads the dev key from `apps/web/.env.local`: staging runs on the Clerk dev instance (`faithful-falcon-1887.clerk.accounts.dev`), not the production one.
