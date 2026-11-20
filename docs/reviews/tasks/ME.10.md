# ME.10 review: private notes stay private, and the never list holds on write

## Verdicts

- Round 1, commit dead7258: clean. No must-fix.

## What changed

- Private notes. The library service already hid another person's `memory/private/<userId>.md` from runs (ME.3: `mayReadMemoryPath` inside `canReadAt` and `canWriteAt`, the person coming from `runs.onBehalfOfUserId`). Every run path reads through the service: the library tools, the daemon routes, the VM sync and the live-sync audience. So this task added no new filter and pinned the behaviour down with tests at four levels: the service (history and stat too), the MCP library tools, the daemon's `/api/runs/:id/library` routes and the VM sync (sync in and a pull of announced paths). A run for A reads and syncs A's file, a run for B does not, and a run with no person gets none.
- `librarySyncScope` still returns whole folders, because a root is a path prefix and the daemon and the VM walk it through the service. Its header comment now says where private files are filtered.
- Never list. `memory/guards.ts` has `neverEntryIn`. `memory/service.ts` runs it in `submit` for every add and edit, the workspace list first and then the agent's, before the learn level. A match throws an `invalid` error naming the entry and the list, which the `remember` tool hands back as a validation error. The service writes one `memory_changes` row with status `rejected`, `decided_at` set, no `decided_by` and no library version. The row's text names the entry and does not repeat the note.
- `docs/v4/memory-format.md` has a new section, "The never list on write".

## Nits left

- The matcher never splits an entry on "and" or "or", so the three default workspace entries ("Passwords and keys", "Card and bank numbers", "Health details") match only that exact phrase. Secrets and card numbers are still caught by the secret patterns. Decide whether the defaults should become shorter entries.
- Plurals are a trailing "s" only ("Salary" does not match "salaries"). A possessive splits into two words ("Tom's" is "tom s").
- `approve` and `undo` write without the never check. A held note approved after the list changed, or an undone forget of a note now on the list, still goes through. Both are person actions.
- `loadAgent` runs a second query for the workspace never list on every memory call. It could run in parallel with the agent query.
- `rejected` now also means an automatic refusal. Only `decided_by = null` tells it apart from a person's rejection. Whichever UI reads change rows first (Knows tab) should show it.
- A user's plain library write under `agents/<slug>/memory/` skips the memory service, so it skips the never list. This predates the task and the docs say only the service writes there.

## Beyond scope

- A run in a multi-person session (Slack, artifact, a2a) still sees the private file of the person its `onBehalfOfUserId` names, through the library tools and the sync. ME.5 keeps private notes out of the prompt in those sessions. The library could hide them there too.
- A daemon working copy keeps a private file it synced for person A until the next sync in removes it. A later run for person B on the same machine does not receive the file, and the sync in deletes the unchanged local copy, but a file on disk in between is not covered here.
- DR.4 (the dream run) must call `neverEntryIn` on the notes it writes, since it applies its plan outside `submit`.

## Test notes

- `bun run check` and `bun run build` pass. `bun run test`: services 4606 pass and one timeout, `an hour of never-claimed runs stays bounded` (over 60 s under load, passes alone in 67 s). Web 4598 pass and one fail, `guest-execution.test.ts`, which fails alone as well and is the known FX.1 flake; `room.test.ts` passes alone. The agentum-rs tests that need a D-Bus socket fail from the long worktree path, and one needs `claude` on PATH; both are host problems.

## Steps for Dom

None.
