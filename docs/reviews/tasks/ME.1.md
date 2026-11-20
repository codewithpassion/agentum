# ME.1 review

## Verdict

Round 1, commit 858ddeb6: must-fix. Two items. Note text could hold line breaks although the format says one line, and `merge` had no definition.
Round 2, commit ea5993ec: must-fix. Merge rows were grouped by `library_version_id`, which is empty while a merge is held.
Round 3, commit cdd23f5e: clean. No must-fix findings.

The fixes: the service collapses line breaks and whitespace runs to one space before it counts characters. `memory_changes` gained a nullable `group_id` (the id of the `merge` row, set on it and on the `forget` row of each absorbed note). The format doc says a merge group is written together with one status, and that `decide` and `undo` act on the group. Migration 0055 was regenerated for the extra column.

## Nits left

- `packages/services/src/memory/service.ts`: `decide` and `undo` authorize with the change id as the resource id, and `undo` takes a bare `changeId`. Both follow KY.1. They return one `MemoryChange` even when they act on a group, and the doc does not say which row.
- `packages/services/src/memory/service.test.ts`: the system principal check relies on the stub throwing synchronously. ME.3 will make the methods async and must change it, and delete the stub assertions (writes are `not_found`) here and in `router.test.ts`.
- `docs/v4/memory-format.md`: the example ULIDs start with `01HZ`, a 2024 timestamp, while the note dates are in 2026. The 500 character limit counts UTF-16 code units, so an emoji counts as two.
- `packages/db/src/shared.ts`: `DEFAULT_REMEMBER_RULES` is a mutable exported object. The service clones it.
- `packages/services/src/agents.ts`: `remember: DEFAULT_REMEMBER_RULES_JSON` in `insertAgent` repeats the column default. It is there because `AgentRow` needs the field, as for `avatar`.
- `packages/db/src/schema/memory.ts`: no index on `(workspace_id, group_id)`. Groups are small.

## Beyond the scope

- `@repo/services/memory` has no merge write. The dream (DR.4) needs an internal one that writes the `merge` row and the `forget` rows together. The controller should name its owner (ME.3 or DR.4). ME.2's `apply` already covers merge on the files.
- `docs/tasks/ME.3-memory-service.md` says `undo(changeId)` reverts one change. With the merge group it reverts the group. Controller's file.
- A note's source is `session`, `run` or `request`, so ME.3's guard for notes whose only source is outside mail, a web page or an A2A peer cannot read that from the source kind. ME.3 has to work it out from the run (its trigger or on-behalf-of) and does not need a new column.
- The dream writes as a run principal for the agent. If DR wants `written_by: dream` and `dream_run_id` set, the add path needs an internal entry that takes them. The tRPC `add` never accepts them.
- `rules.set` takes the whole `RememberRules` object, not a patch. The workspace never list is read only here, since the task gives no way to change it.

## Test notes

- `bun run test` passed in full once. On later full runs (also after `git merge main`), only `guest-execution.test.ts` in apps/web failed (miniflare "other side closed", host load average about 12). Run alone it failed once under that load and passed on the next run (120 s). Known flake, recorded in `docs/reviews/tasks/NV.1.md`. All other packages passed, and `bun test scripts` passed.
- The migration applies locally with `wrangler d1 migrations apply DB --local`. An ad-hoc upgrade check (migrations 0000 to 0054, then a workspace and an agent inserted, then 0055) gave the defaults to both existing rows and left no foreign key violation.

## Steps for Dom

- The task's check says the migration applies on a copy of staging data. A dispatcher may not touch remote D1. Run `bunx wrangler d1 migrations apply DB --remote --env staging` from `apps/web` (or apply it to an export of staging) after the merge. 0055 adds two columns with constant defaults and one new table, so existing rows are safe.
