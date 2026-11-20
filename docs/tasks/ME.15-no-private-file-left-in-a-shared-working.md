---
id: ME.15
title: "No private file left in a shared working copy"
milestone: ME
size: M
status: todo
depends_on: []
branch: null
lane: runtimes
executor: claude
---

From the ME gate review, round 1 (`docs/reviews/ME-1.md`, MF-2). Private notes stay with their person (Dom, 19 Nov 2026).

## Scope

On the Linux VM and on the machine daemon, a working copy that outlives one run must never hold a private memory file when a run for another person, or for no person, can read it. Options for the implementer: keep private files out of the shared copy and give the run its own private notes another way (the prompt already carries them), or give each run its own per-person folder that is removed at run end. At minimum, a sync-in removes any private file not in the run's remote list whatever its local state, a failed or timed-out sync-in does not start the run with the previous person's file in place, and the memory folder syncs as read-only, since a run can never write there.

## Check

A VM test with one VM and one working copy: sync in for a run for A, then for a run for B, and B's copy has no `private/A.md`, both while A's run is still live and after it ends. The same with A's file edited locally and with the lock held so B's sync times out. A daemon test: after a run for A, a run for B and a routine run see no `private/A.md` in the working copy, including when the local copy was edited and when sync-in fails. `bun run check && bun run test && bun run build` pass, and `cargo test` in `apps/agentum`.

## Log
- 2026-11-20: added from the ME gate review, round 1.
