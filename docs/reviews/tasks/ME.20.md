# ME.20 review: a run that sees a person's private notes writes to their private file

## Verdicts

- Round 1 (8fb3a3d): not clean, 2 must-fix. The new test did not tie a held private change to the `userScope` column that the desk and roster filter on, and `edit` let a run whose scope is a private file change a shared note with text from that chat.
- Round 2 (e19f727, fixes only): clean.

## Design notes

- `scopeOfRun` in `memory/provenance.ts` takes a run's file from `privateNotesUserOf`, the read rule in `library/private-notes.ts`. A person's own "remember from chat" still goes by `session.private`, as before.
- A private session the rule gives to nobody still writes to the file of the person the run works for, never to a shared file. This is the old behavior and no current path makes the two differ.
- A run that sees private notes may add to or edit only private notes. Forget of a shared note is left alone, since it writes no text.
- The shared run fixtures in `memory/test-world.ts` moved from the `ui` session to a new team-room session (`RUN.room`), because a run in A's own `ui` chat now writes privately. `runs.test.ts` starts its memory run in an `inbox` session for the same reason, and because its test user id is not a Clerk id.
- `docs/v4/memory-format.md` states one rule for reading and writing.

## Nits left

- The error from `edit` says "A run in a private conversation", but an ordinary `ui` chat is refused too.
- The held-change test reads `memory_changes` rows with no ORDER BY.
- No test shows that a run in A's chat can still edit A's own private note.
- The hand-off test seeds its private `mcp` session by hand instead of starting a hand-off through `runs.ts`.
- A person who names their own `ui` run as the source now gets their private file, while naming the same session gets a shared note. The web UI names a session, never a run.
- `forget` of a shared note from a private-scope run is allowed.

## Beyond scope

- Run the desk and roster through a real `ui` run's held change in one test, instead of relying on `rail.test.ts` for the filter.
- The two options the task names if the controller later dislikes the cost: drop `origin === "ui"` from the rule, or hold such shared notes for the person to approve (never for the owner).

## Steps for Dom

None.
