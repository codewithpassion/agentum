# Review: W.8 Library folder synced onto machines

## Verdicts

- Round 1 (521d4a3): clean. `bun run check`, `bun run test` and `bun run build` pass.
- Round 2 (c81b948, fix commit asked for by the controller): clean. The claim's `library` key goes only to a daemon that sends `X-Daemon-Features: library-sync` with its claim, so daemons built before W.8 keep parsing their claim. A refused `sudo find` gives a clear message, and a failed sync in leaves no sync out at the end of the run.

## How the task was read

- A machine run has no checkpoint hook, so the daemon sends library changes back every 5 minutes while the run works (`LIBRARY_CHECKPOINT_MS` in `executor.ts`), and once more after the process has exited and before the completion is posted. The run token stops working when the run ends, so the last sync-out has to come first.
- A run that was aborted sends nothing back. Its edits stay on disk, the manifest stays, and the next run's sync carries them, as in W.7.
- The claim carries `library: { paths, conflicts }`. The conflict list comes from the new `library.pendingConflicts` (one query), and the prompt lists it only when the sync-in finished.
- The run-token routes are `/api/runs/:id/library/{list,stat,file,conflicts}` (`apps/web/src/server/routes/run-library.ts`), documented in `packages/services/README.md`. The MCP library tools take no `ifEtag`, which is why a new route was needed.
- The wire shapes are in `@repo/protocol/library`. Etags travel in `X-Library-Etag` and `X-Library-If-Etag`, not `ETag`, so Cloudflare cannot rewrite them.
- On a multi-user machine the local port uses sudo as hm-agent. Listing a folder needed one new command, `/usr/bin/find`, in the sudoers rule.

## Nits left

- An abort also cancels a checkpoint in flight through the abort signal.
- `library-api.ts`: any 400 on a file read counts as "not there", not only a folder.
- Some symbols are exported and used only in their own file or in tests: `LIBRARY_REQUEST_TIMEOUT_MS`, `LIBRARY_MANIFEST`, `diskLocalPort`, `diskManifestStore`, `LIBRARY_CHECKPOINT_MS`, `LibraryConflictRequest`.
- Carried over from W.7: no ignore list in `walkLocal` (a `node_modules` under `agents/<slug>/` would sync), and a new local file is written without a create-if-absent precondition.
- A stat or list that fails for a reason other than "missing" fails the whole sync-out on purpose, so a transient error never reads as a local delete. A non-English locale on a multi-user machine makes "missing" read as a failure, which is safe but means no sync.

- Round 2 nits: the "library synced" assertion in the failed-sync-in executor test would pass without the fix (the "syncing the library" count does the work). The old-daemon route test compares key names, not a pre-W.8 strict schema.

## Ideas beyond the scope

- Sync the library on a machine agent from a single shared helper with the VM's `syncLibraryIn/Out` (both wrap the same module, with different locks and ports).
- A `libraryPaths` field in the agent form (still only in `runtimeConfig`).
- Create-if-absent on `library.write` would close the new-file window.

## Steps for Dom

- Multi-user machines: run `harbourmaster install-service` again. The sudoers rule gains `/usr/bin/find`. Until then the library sync fails with a warning in the daemon log and the run goes ahead without a library copy.
- No daemon rush: a daemon built before W.8 gets the old claim and runs without a library folder. Update daemons to get the sync. A new daemon on a machine that has not re-run `install-service` logs "sudo refused find as hm-agent" and runs without the folder.
- Staging check (controller): a machine agent edits a file under `agents/<slug>/` and the change shows in the library with a `library.write` event. A person edit during the run leaves `<file>.conflict-<runId>` and a `library.conflict` event, and the next run's prompt lists the copy.
