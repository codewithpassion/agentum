# ME.2 review: memory files codec

## Verdicts

- Round 1 (3af5d3dd): not clean, 1 must-fix. Parse accepted text with whitespace runs or tabs inside it, but serialise collapsed them, so a hand-edited file did not round trip byte for byte.
- Round 2 (291b8563, fixes only): clean. Parse now rejects any text that differs from its normalised form, cross-file duplicate and wrong-file errors report the right line (6 lines per kind-file block, 7 per private block), and the unused `applyMemoryChange` and `budgetNotes` export aliases are gone.

The implementation ran in Codex. Checks run by the dispatcher on the worktree: `bun run check`, `bun run build` and the services suite pass. `bun run test` fails only on the known flake `guest-execution.test.ts` in `apps/web`, which also fails on main.

## Reading chosen where the spec was open

- Files must use LF and end with one newline. A CRLF file is reported at line 1.
- An edit keeps the note's position in the file; only its date, writer and text change.
- `apply` validates every supplied note file, so one malformed file refuses the whole change.
- Source ids are opaque (any non-empty text). Lower case ULIDs are accepted.
- `budget` counts note text only and skips a note that does not fit, so a shorter, lower-priority note can still get in.

## Nits left

- A merge can absorb a private note into a kind-file note, and the merged text then shows in `index.md`. ME.3 should refuse a merge across scopes.
- The index cut slices UTF-16 code units and can split a surrogate pair at character 80.
- `budget` skips an oversized note and keeps going. ME.5 should confirm that is the wanted behaviour.
- `kind as MemoryNoteKind` in `codec.ts` is a type assertion where narrowing would do.
- An unknown note id in `apply` reports path `.` and line 1, which is not a real file.
- A file with a non-canonical title parses and is rewritten with the canonical title, so it does not round trip byte for byte. The format doc says the title is ignored on parse.
- No test covers the 7-line private-file step or the line number of the wrong-file error from `serializeMemoryFile`.

## Beyond scope

- ME.3 owns the rules that keep private text out of the index and out of shared files. The codec only does what it is told.

## Steps for Dom

None.
