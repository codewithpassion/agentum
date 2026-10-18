# Review: W.3 VM snapshot after each run, with a workspace.snapshot event

## Verdicts

- Round 1 (9bb7708): clean. No must-fix findings. `bun run check`, `bun run test` and `bun run build` pass.

## Nits left

- `checkpoint` ignores `busy`, so another session's call can be writing while the home folder is backed up. The idle path refuses in that case.
- A restore reports the size but never a warning, and a failed `du` after a restore reports `bytes: 0` with no warning.
- A missing home folder writes no event for a checkpoint or an idle snapshot, though the port comment says every checkpoint does. `prepareWorkdir` always makes home, so this is rare.
- `VmSession` calls `compose(env)` on every report. `PiRun` caches it.
- No test covers the `PiRun` side: checkpoint after completion, the skip without VM ids, `setRun` on start.
- `#checkpointVm` does nothing when `#vm` is unset, which could be the case for a run completed by `resume()` right after an eviction before the harness opens. Not verified.
- The header comment of `vm-core.ts` runs past 80 columns.

## Ideas beyond the scope

- `RUN_KEY` holds the run that called `setRun` last, across all sessions of the agent. A restore started by session A can land on session B's run, and an idle snapshot lands on a run that may have finished long ago. Fixing it needs the run on every VM call.
- `complete` in `PiRun` waits for the `du` and the backup, which adds latency to each VM run's completion. A fire-and-forget checkpoint through `ctx.waitUntil` would remove it.
- A failed restore still deletes the stored snapshot (unchanged behaviour). Keeping it would let a later restore try again.

## Steps for Dom

- None. The staging check is the controller's: query 3 from the report shows a `workspace.snapshot` event for each VM run.
