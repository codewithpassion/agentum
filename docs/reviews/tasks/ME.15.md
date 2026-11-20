# ME.15 review: No private file left in a shared working copy

## What was built

Private memory files (`agents/*/memory/private/**`) never enter a working copy that outlives a run, in either direction. A run gets its person's private notes from its prompt, so it does not need the file. The agent's own `memory` folder syncs as a read root, since a run never writes there.

- Linux VM, `apps/web/src/server/linux-vm/vm-library-sync.ts`: the remote port hides private paths for list, stat, read, write and delete. `syncLibraryIn` first removes every `agents/*/memory/private` folder from the VM copy (read from the disk, not the manifest), before the lock and outside the catch, so a lock timeout or a library failure still leaves none and a failed purge stops the run. `syncLibraryIn` takes `waitMs` for the lock wait.
- Daemon, `apps/agentum/src/library.rs` and `runs/executor.rs`: the same wrapper (`WithoutPrivate`), the same read root, and a purge at the start of every run before any sync, so routine runs without a library and subagent workdirs are covered as well.
- `docs/v4/memory-format.md` says so.

## Rounds

| Round | Commit | Verdict | Notes |
|---|---|---|---|
| 1 | bb874541 | must-fix | One: a link at `library/agents/<slug>/memory`, or a file in place of `library`, made the daemon purge fail and so failed every later run of that agent. |
| 2 | 655a291c | clean | The purge now falls back to removing the whole copy and its manifest, and fails only if that fails. Test added. Two nits taken afterwards (manifest removed first, walk error logged). |

## Nits left

- Daemon, sudo disk: `stat` and `rm` follow a symlinked `memory` folder, so the purge can delete `private/` at the link's target as the agent user, and the reset fallback does not run there.
- Daemon, case-insensitive disks (macOS): `memory/Private/...` is not private to the library, but the purge deletes it and sync pulls it back every run.
- Daemon: any walk error triggers the full reset, transient ones included. Private files still go, and the cost is a re-download and unpushed edits in writable roots.
- Daemon: an agent that turns `library.manifest.json` into a folder and also breaks the walk would still stick every run.
- Tests: the VM A-then-B tests do not end A's run with a sync out, and the daemon end-to-end test claims carry no `onBehalfOfUserId`. Subagent workdirs and a sync after the reset are not tested.
- A write grant over another agent's home leaves that agent's `memory/` in write mode, so its edits fail at the library. Already true before.

## Ideas beyond the scope

- Refuse `agents/*/memory/private` on the run library routes (sync list, read, stat), so the managed sandbox transfer (`packages/library-sync/src/transfer.ts`) and daemons that were not updated cannot receive a private file either. ME.14's rule for who may see a private file is the place for it.
- The prompt text of both runtimes still lists the home as write. The memory folder inside it is read-only now.

## Steps for Dom

- The server no longer lists, stats or reads a private memory file for any daemon (ME.21), so a machine that is not upgraded gets no new private file. Copies that already hold one keep it until the machine is upgraded. After the release, upgrade each machine that has run before. The purge then removes what is already there on the first run.
- Cloud VMs need nothing: the first run after deploy purges the shared copy.
