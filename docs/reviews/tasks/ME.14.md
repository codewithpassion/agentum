# ME.14 review: one rule for who may see a person's private notes

## Verdict per round

Round 1, f0e5b665: clean. No must-fix. The reviewer reverted each source file and kept the new tests: 16 library, audience and session tests and 9 launch-context tests fail without the change. `bun run check`, `bun run test` and `bun run build` pass.

## What changed

`packages/services/src/library/private-notes.ts` holds the rule. A run sees `memory/private/<userId>.md` only when its session is private or has origin `ui`, and the session's actor is that user. The prompt (`launch-context.ts`), the library (`resolveMember`, so the tools, daemon routes and VM sync follow), the audience and the session reads (`visibleSessions`, which guards `search_history`, list and transcript for runs) all call it. The origin list is gone from the prompt path, so a Slack DM gets its notes back.

`search_history` follows the rule. Without it, a team room run started by A could read A's `ui` and private sessions through `search_history` and `read_session`, which leaks the same notes in another form.

## Nits left

- `sessions.ts` `visibleSessions`: a run reader loads the same run up to three times and the session once. `openerOf` and `personalOwnerOf` could share one load.
- `memory/provenance.ts:33,78`: the memory actor's `userId` is still `run.onBehalfOfUserId`, and its comment says it names the private file the caller sees. The library refuses the file anyway, but this is a second source of truth.
- `library/memory-paths.ts:3`: the header comment still says a private file is for "the agent's runs for that person". The rule is narrower now.
- No test asserts that a subagent of a private `ui` run keeps the notes and a subagent from a team room gets none. The hand-off privacy test exists at `sessions.test.ts`.
- `vm-library-sync.test.ts`, `library-ports.test.ts` and `routes/mcp.test.ts` only moved their fixtures onto `ui` sessions. The shared-session negative cases sit at the service layer.

## Ideas beyond the scope

- The artifact branch of `visibleSessions` still keys on `run.onBehalfOfUserId`. A team room run that A started can list and read the agent's chat sessions on A's private-audience artifacts. This is the same kind of leak for artifact chats.
- Agent-builder dry runs open private `dry_run` sessions with the builder as actor, so they now carry the builder's private notes. That matches the rule as written. Confirm it is intended.
- A non-private `ui` session writes its notes to the shared files, while the same session now also reads the person's private file. Decide whether `ui` notes should go to the private file.

## Steps for Dom

None.
