# TM.22 review

## Verdicts

Round 1, commit 24f27d13: clean. No must-fix.

## Notes on the change

- `newSessionOwner` in `runs.ts` skips the parent-privacy inheritance when the new session's origin is `inbox`, `qa` or `slack`. `mcp` hand-offs still inherit on purpose.
- `privateNotesUserOf` returns null for origin `inbox` whatever the `private` flag says.
- `sessions.test.ts`: the inbox case of the subagent-privacy `test.each` became a `slack` case, because a private inbox session is now an impossible state and a private Slack DM is a real one.
- The full `bun run test` showed one miniflare ECONNRESET in `guest-execution.test.ts` under load. It passes alone.

## Nits left

- `private-notes.ts` guards only `inbox`. A `qa` session stored as private before this fix still gives notes (`qa:<questionId>` sessions are reused). Guard `qa` too, or include `qa` in the private = 1 count.
- No test covers a run answering a question from a private `ui` run into a `qa` session.
- `SHARED_ORIGINS` in `runs.ts` is typed `ReadonlySet<string>`, `ReadonlySet<SessionOrigin>` would catch a misspelling.

## Ideas beyond the scope

- Extend the count of private = 1 sessions to `qa` as well as `inbox`.

## Steps for Dom

- Run the read-only count of `sessions` with `origin = 'inbox'` and `private = 1` on staging and production (the controller logs it in the task file). With this change those sessions get no private notes, so the rows are only a leftover flag.
