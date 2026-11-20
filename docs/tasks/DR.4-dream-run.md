---
id: DR.4
title: "The dream run: schedule, model, write, diary, undo"
milestone: DR
size: L
status: in_progress
depends_on: [DR.2, DR.3, ME.3]
branch: task/DR.4-dream-run
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
- 2026-11-20: from the DR.1 review: also create the dream trigger from `dreamSchedule`, pass `DeskCard.dream` through `rail.ts`, and refuse dream rows in `memory.decide`. Details in docs/reviews/tasks/DR.1.md.
- 2026-11-20: notes from DR.2 for the dream run: an empty-absorbed merge is an edit in place; a merge whose text matches the keeper's leaves the keeper's writer and date alone; a question's scope comes from its noteIds; prune's maxChars is the budget less the text of the adds; pass the reconcile held ids to prune.
- 2026-11-20: dispatched on task/DR.4-dream-run (v4 controller session).
- 2026-11-20: from SP.3: the dream run skips an agent whose pausedAt is set.
- 2026-11-20: Haiku price: claude-haiku-5-5 is $0.10 in and $0.50 out per million tokens up to 100K prompt tokens ($0.50 / $2.50 above). DR.4 had set Haiku 4.5's $1 / $5; corrected in its review round.
