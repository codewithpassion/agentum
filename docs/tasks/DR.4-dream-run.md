---
id: DR.4
title: "The dream run: schedule, model, write, diary, undo"
milestone: DR
size: L
status: todo
depends_on: [DR.2, DR.3, ME.3]
branch: null
lane: worker
executor: claude
---

From `docs/v4/build-plan.md`, milestone DR. Tie the dream together and run it on a schedule.

## Scope

- Fill `@repo/services/dream`. A run: read rules and notes, `collectSince`, skip with status `skipped` when nothing happened, extract candidate notes with one model call (leave out anything the never list covers), run the steps from DR.2, then apply the plan through `memory` in one library version with `written_by: dream`.
- Model calls use the workspace's key through the client `agent-builder/draft.ts` uses, on `DREAM_MODEL`. Record usage on the `dream_runs` row.
- Write the diary in plain words from the counts and the plan: what was added, merged, dropped and asked.
- Questions from `reconcile` become `dream_question` Needs you items for the owner. Answering one applies the chosen note.
- `undo` restores the memory files to `base_version` and marks the run's changes `undone`.
- Scheduling: the cron path in `routines/cron.ts` fires `dream` triggers at 02:00 in the workspace timezone, nightly or weekly. Wire the handler in `apps/web/src/server` where routines are dispatched.
- The learn level applies: with `ask_first` the plan is held as one batch.

## Check

- Service tests with a fake model: full run, skipped run, held batch, undo restores the files byte for byte, a question answered both ways.
- A cron test fires a nightly and a weekly schedule across a timezone boundary.
- A failed model call leaves memory unchanged and the run `failed`.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
