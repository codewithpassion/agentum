# DR.1 review

## Verdict

Round 1, commit d87bd5eb: must-fix. Dream questions had no storage and no card shape, the dream router lacked answer, decide and changes procedures, and the map drew the dream trigger although no map call can handle it.
Round 2, commit d60c32d3: must-fix. One comment said `memory.decide` refuses every dream row, but it refuses only merge-group rows.
Round 3, commit 67dbcea4: clean. No must-fix findings.

The fixes: `dream_questions` table (migration 0058 regenerated, so there is one migration), `DreamQuestion` and `DreamNeedsYou` in `@repo/db/shared` with an optional `dream` field on `DeskCard` and `RailCard`, `dream.answer`, `dream.decide` and `dream.changes` stubs, the dream trigger left off the map (`MAP_TRIGGER_KINDS` and the map query) and out of the jobs list, and clearer comments.

## Decisions made in the contract

- The service methods take the principal first and a bare id (`runNow(principal, agentId)`, `list(principal, agentId)`, `get(principal, dreamRunId)`, `undo(principal, dreamRunId)`), as the repo rule needs `authorize()` on every read. The task text wrote `list(agentId)` and `get(id)` without a principal.
- `base_version` is a JSON array of library version ids, one per memory file that existed before the dream. A file the dream created has no entry, so undo finds its versions through the run's `memory_changes` rows. `result_version` is the last version the dream wrote. A dream can write several files, so the single id is informational.
- `DreamPlan` is a list of four change kinds that match the four counts: `add`, `merge`, `drop`, `question`. Skill proposals are not in the plan, because DR.5 files them through `skills-store`.
- One live dream trigger per agent is a partial unique index on `triggers(agent_id)` where `kind = 'dream'` and `revoked_at is null`. `triggers.create` has no `kind` input and makes `http` only, so a person cannot create one. The routine tick filters on `kind = 'routine'`, so a dream trigger with a `next_run_at` does not fire as a routine.
- `DREAM_MODEL` is `claude-haiku-5-5`.

## For the downstream tasks

- DR.4 creates and removes the dream trigger from `agents.remember.dreamSchedule` (`memory.rules.set`, agent creation and a backfill for existing agents). No DR task names this yet. The controller should add it to DR.4.
- DR.4 passes `DeskCard.dream` through to `RailCard.dream` in `packages/services/src/rail.ts`. The one-line spread pushed that function over the cognitive-complexity limit of 20, so extract a helper first.
- DR.4 makes `memory.decide` refuse any row with a `dreamRunId` (today it refuses only merge-group rows), and routes a held batch through `dream.decide`. The `decide` comment in `dream.ts` already says so.
- DR.4 needs an entry for a scheduled run. `runNow` refuses the system principal, as `readableWorkspace` does.
- DR.4 guards `triggers.reassign`, `setEnabled` and `revoke` against a dream trigger (today `reassign` refuses only `app`), so a person cannot move one to an agent that has its own.
- `authorize` gets the agent id for `list` and `runNow` and the run or question id for the rest. DR.4 should pick one resource shape.

## Nits left

- `packages/services/src/dream.ts`: the `runNow` stub rejects with `not_found` and "No dream ran". The comment on `decide` says "refuses merge rows"; it also refuses the `forget` rows inside a merge group.
- `apps/web/src/server/trpc/triggers-router.test.ts`: the refusal test passes because the create schema is a strict object with no `kind`, so it would pass for any kind.
- `packages/db/src/schema/memory.ts`: `dream_run_id` stays a plain id. A foreign key would rebuild `memory_changes`.

## Beyond the scope

- A dream's model cost is recorded in `dream_runs.usage`. The spend rollups read `runs.usage`, so a dream does not count against the weekly cap until SP's rollup reads `dream_runs` too. The controller should name the owner.
- `jobs.list` and the map hide the dream trigger. The Knows tab (DR.6) is its only home.

## Test notes

- `bun run check` and `bun run build` pass, and the migration applies on a fresh local database with `wrangler d1 migrations apply DB --local`.
- `bun run test` under load fails two timing tests and nothing else: `guest-execution.test.ts` in apps/web (known flake, fails alone about half the time here) and "an hour of never-claimed runs stays bounded" in `packages/services/src/runs.test.ts` (passes alone, 174 tests in 67 s). The reviewer reproduced the first on the base commit. After `git merge main` a full run also failed one `agentum-rs` test (`prerequisites_probe_only_fake_binary_and_check_only_version`, claude missing from PATH) once and passed on the next run.

## Steps for Dom

- None for DR.1 itself. Migration 0058 adds one table and a partial unique index on `triggers`, with no data change. Apply it with `bunx wrangler d1 migrations apply DB --remote --env staging` from `apps/web` after the merge.
