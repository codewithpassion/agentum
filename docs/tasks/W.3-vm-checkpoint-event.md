---
id: W.3
title: VM snapshot after each run, with a workspace.snapshot event
milestone: W
size: S
status: done
depends_on: [W.2]
branch: task/W.3-vm-checkpoint-event
---

Asked for by Dom on 18 Oct 2026, from the report (section D, items 3 and 4). The only snapshot today runs from the idle alarm, so a host stop loses everything since the last one, and a failed restore silently starts empty.

## Scope

- Add `checkpoint()` to the VM port. `PiRun` calls it when a run that used the VM completes. A failed checkpoint is logged and keeps the VM up.
- Add `workspace.snapshot` to `EVENT_TYPES` with `{ ok, bytes, ms, error?, warning? }`. Write it for checkpoints, idle snapshots and restores, on the run that triggered it. A failed restore writes `ok: false`.
- Measure home with `du -sb` before each snapshot. Over 1 GB adds `warning` and refuses nothing (soft cap).

## Check

- `vm-core.test.ts` covers a checkpoint, a failed checkpoint that keeps the VM up, a failed restore event, and the over-size warning.
- Live on staging (controller): query 3 from the report shows a `workspace.snapshot` event for each VM run.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-18: added at Dom's request.
- 2026-10-18: dispatched.
- 2026-10-18: review clean after 0 fix rounds at da866ed (docs/reviews/tasks/W.3.md). Merged.
