# ME.4 review: agent tools remember, forget_note and search_history

## Verdict per round

Round 1, commit 36f5d6ff: clean. No must-fix findings. Scope and check covered: applied and held replies, the peer refusal (also down a peer chain, for `remember` and `forget_note`), history limited to the run's own agent and visible sessions, a forged agent id, read-only servers dropping the write tools.

Checks on the branch: `bun run check` and `bun run build` pass. `bun run test` fails only in `apps/web` `guest-execution.test.ts`, the known flake that also fails on main. It passes alone in the reviewer's run and the diff does not touch it. The reviewer also saw one Rust test (`desktop::apps::tests::the_session_bus_listens_where_the_environment_says`) fail because the worktree path is too long for a D-Bus socket. That is an environment limit, unrelated to this diff.

## Nits left

- `packages/services/src/runs.ts` `isPeerRun` loads the run twice (`getRun`, then `requireRun`). One extra read per `remember` or `forget_note`.
- The peer rule lives in the app port (`apps/web/src/server/mcp/memory-ports.ts`), not the memory service. Move or repeat it there when the real service lands.
- The session mapping in `memory-ports.ts` duplicates `toSessionInfo` in `apps/web/src/server/mcp/ports.ts`.
- The `search_history` text formatter repeats `hitText` from `tools/sessions.ts`, with a date added.
- The note text schema in `tools/memory.ts` copies `noteTextSchema` from the memory service, so the two can drift.
- `MemoryPort` hard-codes the note kind and change status unions instead of using `MemoryNoteKind` and `MemoryChangeStatus` from `@repo/db/shared`.
- The `search_history` text line shows `createdAt` only. `lastRunAt` is in the structured data.
- The `TOOL_NAMES` comment in `packages/mcp/src/server.ts` does not list the memory tools, which need the run-only memory port.

## Ideas beyond the scope

- `search_history` limit counts sessions (default 10, max 20), because `sessions.search` caps at 20 sessions. A per-passage limit would need a service change.
- Both `forget_note` and `remember` throw `forbidden` for peer runs. A future peer-visible read tool for memory could reuse the same guard.

## Steps for Dom

None. The memory service is still the ME.1 stub, so `remember` and `forget_note` return a not-found error against real data until the service task (ME.3) lands.
