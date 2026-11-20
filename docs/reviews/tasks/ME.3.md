# ME.3 review: memory service

## Verdicts

- Round 1 (da249ded): not clean, 3 must-fix. Approving a held add and undoing a forget could overwrite a memory file that does not parse, because the plan treated it as empty. The peer-run refusal and `runs.isPeerRun` were still in the MCP memory port after ME.4 merged.
- Round 2 (9f14e1fa, fixes only): clean. `commitChange` refuses any file that does not parse before it writes. The refusal and `isPeerRun` live only in the memory service. Two nits also went in: a run principal must match its stored run's agent, and the library's memory write checks that a run holds write access to the path.

Checks run by the dispatcher on the worktree: `bun run check` and `bun run build` pass, and the services suite passes alone (4517 tests). `bun run test` fails only on the known flake `guest-execution.test.ts` in `apps/web`, which also fails on main. One run also failed the services test "an hour of never-claimed runs stays bounded" at 62 s while the host was busy. It passes alone and in the services suite.

## Readings chosen where the spec was open

- The `memory_note` Needs you item is the held `memory_changes` row. ME.8 adds it to `desk.railSources`, so ME.3 writes no separate item.
- Outside text is read from the note's source: a session or run whose origin is `mail` or `a2a`, a run with a peer in its parent chain, or a run that made a `web_fetch` call or a browser action. Any of these holds an agent's add, edit or forget at every level. A person's own write applies.
- A peer-origin run is refused outright (`ForbiddenError`), as ME.4 asked. The MCP port turns that into a generic "This credential may not do that." reply.
- A run always writes as itself: its source is its own run, and another source is `invalid`. A person may name a conversation as the source, and a private one fills only their own private file.
- A private session's note goes to the person the run works for (`runs.on_behalf_of_user_id`). A private session with no such person refuses the note.
- A held add or edit is dated the day a person approves it. The version author is the person who approved.
- Undo restores a note from the library version before the change, so an edit or a forget comes back with its exact date, writer and source. It refuses with `conflict` when the note is no longer as the change left it.
- The library hides another person's `private/<userId>.md` from list, stat, read, history and move, and refuses a write to it. A run is refused any write, delete or move under `agents/<slug>/memory/`. `library.writeMemoryFiles` is the one way in, and `sole-writer.test.ts` fails if another file calls it.
- A file that does not parse is skipped by `list`, refused for a new note of its kind with its line number, and never written.
- `decide` and `undo` refuse a `merge` row or a grouped row, because nothing writes merges yet.

## Nits left

- `add` checks the target file in its own plan and `commitChange` checks it again. One check could go.
- Approving an edit or forget, or undoing an edit, against a broken file fails with "no longer in memory" before the file is named.
- No test shows that a refusal from the plan is not retried.
- `decide` and `undo` race with each other: the file write happens even if the guarded status update then matches no row.
- The first write of a new memory file or of `index.md` is unconditional, because `LibraryBlobs.put` has no create-only option. Two first notes at once can lose one.
- `restoreObjects` puts old bytes back without `ifEtag`.
- Web detection matches `"via":"web_fetch"` with LIKE on the event payload text.
- `changes.since` accepts any non-empty string.
- The password pattern also matches prose such as "password is stored".

## Beyond scope

- Merge rows: DR needs `decide` and `undo` for a group, and a refusal to merge a private note into a shared one (the ME.2 nit).
- A dream needs a way to write as `dream` with a `dream_run_id`. The add, edit and forget inputs have no field for it yet.
- "Only source" is approximated by the run's whole history. Message-level provenance would let a note a person said aloud in a mail thread apply.
- Machine library sync now has `agents/<slug>/memory/` as read-only for runs. A daemon that edits those files locally gets a refused push.
- A workspace never list that people can edit has no tRPC procedure yet. `rules.set` changes the agent's list only.

## Steps for Dom

None.
