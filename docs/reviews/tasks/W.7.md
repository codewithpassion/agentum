# Review: W.7 Library folder synced into the Linux VM, with the shared sync module

## Verdicts

- Round 1 (8bbb3f3): must-fix, three items. A conflict copy entered the manifest before its local write, so a failed write could later delete the library copy. Sync out made a conflict copy even when the library file held the same bytes. Nothing made syncs on the shared working copy take turns, and sync in could overwrite an edit made between its hash and its write.
- Round 2 (09669a8): the three items were fixed. Must-fix again on the new mkdir lock: a failed `stat` deleted a live lock, and the stale takeover was not atomic.
- Round 3 (e435f8b): the lock moved into the VM's Durable Object. Must-fix: it was held in memory only, so a reset of that object freed it while the holder kept syncing.
- Round 4 (60e21a1): clean. The lock is a lease `{owner, expiresAt}` in the object's storage, renewed while a sync runs. `bun run check`, `bun run test` and `bun run build` pass.

## Nits left

- `withLibraryLock` ignores a `false` answer to a renewal and swallows its errors, so a sync that lost its lease carries on without a warning.
- The renewal ordering relies on calls through one stub arriving in order. Nothing says so in the code.
- The renewal test uses real timers and does not assert that renewals stop after the work ends. The throw path has no test.
- The reset test copies fake storage into a new core. It proves the lease is read from storage, not that a real reset keeps it.
- Round 1 and 2 nits not fixed: a new local file is written without a precondition after `stat`, so a person who creates the same path in that window is overwritten (the library has no create-if-absent). A local delete is `stat` then an unconditional delete, which the task accepts. A library file deleted during a conflict is recreated from the local file on the next sync out. A library folder at the path of a new local file makes a new conflict copy every run. `libraryCopyOf` hides pending conflicts from the prompt when a sync in failed. `walkLocal` has no ignore list, so `node_modules` under `agents/<slug>/` would sync. A pull of a file that is missing locally with no manifest entry has no recheck before the write. Manifest entries of roots removed from `libraryPaths` stay. `result.skipped` is not logged. The sync in and sync out sort with different comparators.
- `pi-run.ts` imports `cloudflare:workers`, so the three lines of wiring there (sync in on the VM branch of `startRun`, sync out before `completeRun` and the checkpoint, the principal and `recordConflict` binding) have no unit test. Everything they call is tested in `vm-library-sync.test.ts` against the real library service and the fake VM.

## Ideas beyond the scope

- The working copy lives outside home, so an idle VM that sleeps mid-run loses unsent edits. A sync out before the idle snapshot, or a periodic one during long runs, would close that. Today "run end" and "checkpoint" are the same moment.
- A run that is cancelled never reaches `complete`, so its edits wait for the next run's sync out and carry that run's id in any conflict copy.
- Sessions of one agent share the working copy. A per-session working copy would remove the shared-manifest problem, at the price of more copying.
- Create-if-absent on `library.write` (R2 `etagDoesNotMatch: "*"`) would close the new-file window.
- W.8 reuses `packages/library-sync`. Its local port is the machine's disk and its remote port is the same `libraryRemotePort` mapping with the run token's principal.

## Steps for Dom

- Staging check (controller), from the task: a VM agent edits a file under `agents/<slug>/` and the change shows in the library page with a `library.write` event after the run. A person edits the same file mid-run, and the run leaves `<file>.conflict-<runId>` with a `library.conflict` event while the person's version stays. The next run's prompt lists the copy.
- Also on staging: start two sessions of one agent at once and confirm both syncs finish (the lease makes them take turns). A warning "Another sync holds the library lock" in the logs means one waited over 30 seconds.
- Set `libraryPaths` (a list of library paths) in an agent's `runtimeConfig` to sync more than `agents/<slug>/`. There is no form field for it yet.
