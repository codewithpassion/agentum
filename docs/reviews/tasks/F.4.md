# F.4 review

## Verdicts

Round 0, commit 10135be: not clean, two must-fix. The service tests only downloaded an attached library file as a user, not as a run that lists it in `input_file_ids`. The local-dev check had no record yet.

Round 1, commit 0bd907e (adds the run-principal download test): clean. One fix round.

## Decisions

- The two stores stay apart and a link copies bytes. A new `library-links` service (`packages/services/src/library-links.ts`) takes `files` and `library` and has two methods, `attach` and `save`. Neither service learned about the other.
- `attach` reads the library file as the calling user and uploads it through `files.upload` with a new optional `source: "library"`. `FILE_SOURCES` gains `library`. `files.source` is a plain text column, so no migration (`bun run generate` reports no schema change).
- `save` downloads the file through `files.download` and writes it through `library.write`, which already records the `library.write` event with the user as actor.
- Both are for users only. A run or machine principal gets `ForbiddenError`. Another workspace's library path or file id is `not_found`.
- tRPC: `files.attachFromLibrary({ path })` and `files.saveToLibrary({ fileId, path })`. The daemon is unchanged.
- UI: the chat composer has a "From library" button and a small folder-browsing picker. An assistant message's file chips have "Save to library", a dialog prefilled with `/outputs/<agent name>/<file name>`.

## Check, run live

Local dev, vite on port 3417, the compiled daemon enrolled with its own HOME under `harbourmaster-wt/tmp/F.4/home` (single_user, `CLAUDE_CONFIG_DIR` pointing at the existing login). Uploaded `note.md` to the library, created a machine agent, attached the note with "From library" and asked the agent to read `inbox/` and write `word.txt`. The agent's Read tool output showed the note's text, and it attached `word.txt`. The chip's "Save to library" offered `/outputs/Heron/word.txt`, and after saving the file showed at `outputs/Heron` on the library page. The composer's own attachment chip has no save action.

`bun run check`, `bun run test` and `bun run build` pass, and the bundle grep for `drizzle` finds nothing.

## Nits left

- Attached library files are `application/octet-stream`, because the library stores no type. Downloads and the daemon's work files lose the real type.
- `library-links.ts` takes the name with its own last-segment regex, and `files.sanitizeName` does the same cut.
- `save` reads the whole file before `library.write` refuses anything over 10 MB. Checking `file.size` first would avoid it.
- `save` overwrites a library file at the target path without a warning (no `ifEtag`), so two outputs with one name from one agent clobber each other at the default path.
- The Save button stays enabled after a successful save, so a second click writes again and logs a second `library.write`.
- `path` in the two tRPC inputs has no maximum length. The service normalises and caps paths.
- No test for a run downloading a library copy its run does not list. `files.test.ts` covers the general `not_found`.

## Ideas beyond the scope

- A "Save to library" action in the read-only session transcript at `/sessions`, which does not know the agent name today.
- Store a type with each library file, or guess it from the extension on attach.
- Show the picker's folder path as breadcrumbs, and allow picking several files at once.

## Steps for Dom

None. No new binding, secret or remote migration.
