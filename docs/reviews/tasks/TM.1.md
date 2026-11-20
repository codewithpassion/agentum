# TM.1 review

## Verdict

Round 1, commit d129665a: must-fix. Three items. A new inbox thread was written with `team_id` NULL, so threads made after the migration sat outside every room. A workspace made after the migration had no "Everyone" team. The check "migration and backfill apply on a copy of staging data" had no evidence (remote D1 is Dom's, see Steps for Dom).
Round 2, commit eb76c9b4: clean. No must-fix findings.

The fixes: `inbox.createThread` puts a new thread in the workspace's Everyone team (NULL only when the workspace has none). `workspaces.create` inserts the Everyone team, and is safe to repeat. A partial unique index `team_members_home_unique` gives a member at most one home team. The backfill skips a workspace that already has an Everyone team. `EVERYONE_TEAM_NAME` and `EVERYONE_TEAM_SLUG` are in `@repo/db/shared`.

## What the contract holds

Migration 0057 adds `teams`, `team_members`, `member_profiles` and `inbox_thread_members`, plus `inbox_threads.team_id` (nullable, indexed) and `opened_by_agent_id`. The backfill makes one "Everyone" team per workspace (no lead, no owner, `lead_listens` on) and gives every existing thread its id. `team_members` and `inbox_thread_members` also carry `workspace_id`, which the task's column list leaves out, because `schema.test.ts` requires it on every table.

`@repo/db/shared` has `Team`, `TeamMember`, `MemberProfile`, `TEAM_MEMBER_KINDS`, `EFFORT_LEVELS` and `CONTEXT_BUDGETS`. The agent `runtimeConfig` schema (in `packages/services/src/agents.ts`) accepts optional `effort` and `contextBudget` and keeps every other key. `AgentCard.teamId` and `isLead` come from the agent's live home team (`isLead` means it leads that home team). `@repo/services/teams` has `list`, `get`, `create`, `update`, `archive`, `addMember`, `removeMember`, `setLead`, `setRules` and `profiles.get/set`. Reads return empty values, writes are `not_found`. The service takes `{ atomic, clock, db }` and ignores them, so TM.2 does not edit `compose.ts`. The tRPC router is `teams`, with a nested `profiles`.

## Nits left

- `packages/services/src/inbox.ts`: the Everyone lookup ignores `archived_at`. TM.2 decides whether Everyone can be archived at all.
- `packages/services/src/workspaces.ts`: the Everyone insert is a second write outside `atomic`. Both inserts are safe to repeat, and the service has no `atomic` dependency.
- `apps/web/scripts/add-workspace-helpers.ts` and `scripts/e2e/a2a-harness.ts` insert workspaces with raw SQL and make no Everyone team. Their threads get `team_id` NULL, which the schema allows.
- The Everyone backfill ids are `team_` plus 20 hex characters, not ULIDs. Nothing parses them.
- `team_members` and `inbox_thread_members` rows carry a `workspace_id` that nothing ties to their team's or thread's workspace. The service must check it.
- `AgentCard.isLead` is true only for the lead of the agent's home team.
- The agent read path parses `runtimeConfig` with the new schema, so a stored row holding an `effort` outside the list would fail the read. No code wrote those keys before.

## Beyond the scope

- TM.2's `teams.list` should create the Everyone team when a workspace has none (workspaces made by the raw-SQL scripts), and a thread with `team_id` NULL should read as Everyone.
- Everyone has no `team_members` rows. TM.2 and TM.3 decide whether it means every member of the workspace.
- A people's `member_profiles` row has no created-at column. Add one only if a task needs it.

## Test notes

- `bun run check`, `bun run test` and `bun run build` pass in the final run. Earlier runs hit the known flakes: `guest-execution.test.ts` and `live-artifacts/room.test.ts` in apps/web (both pass alone), and one Rust test in `apps/agentum` that passes on a rerun. The reviewers saw the Rust session-bus test fail because the worktree path is too long for a D-Bus socket.
- The migration applies with `wrangler d1 migrations apply DB --local` on an empty database. The backfill is tested on SQLite with seeded threads in several workspaces (`packages/db/src/teams-contract.test.ts`).

## Steps for Dom

- Copy staging's D1 (`wrangler d1 export` then import into a local or scratch database), apply migration 0057, and open a few old threads in the app. Check `SELECT COUNT(*) FROM inbox_threads WHERE team_id IS NULL` is 0 and every workspace has one team with slug `everyone`. The task's Check asks for this and a worker cannot reach remote D1.
- Apply 0057 to staging and production (`bunx wrangler d1 migrations apply DB --remote` from `apps/web`, with `--env staging` for staging). The migration only adds tables and columns, then fills `teams` and `inbox_threads.team_id`.
