---
id: ME.1
title: "Memory contract: tables, file format, router"
milestone: ME
size: M
status: in_progress
depends_on: []
branch: task/ME.1-memory-contract
lane: contract
executor: claude
---

From `docs/v4/build-plan.md`, milestone ME. Contract task for ME. It alone changes `packages/db/src/schema`, generates migrations, edits `packages/db/src/shared.ts`, wires the new service in `apps/web/src/server/compose.ts` and mounts the new tRPC router in `apps/web/src/server/trpc/router.ts`. Every procedure exists after this task with its final input and output types and a stub body, so the service, MCP and web tasks of ME run in parallel against it. Design: `docs/research/ui-reimagine-2026-11/memory-and-dreaming.md`.

## Scope

- Write `docs/v4/memory-format.md`: memory lives in the agent's library home, `agents/<slug>/memory/`. Files `people.md`, `corrections.md`, `work.md`, `places.md`, `index.md`, and `private/<userId>.md` for notes from a person's private conversations. Define the note block exactly: id, text, date, source (session, run or request id), written by (`person`, `agent`, `dream`).
- `agents.remember` (text, JSON): `remember: string[]`, `never: string[]`, `learnLevel` (`ask_first`, `tell_after`, `quiet`, default `tell_after`), `shareWithTeam` (default true), `dreamSchedule` (`nightly`, `weekly`, `off`, default `nightly`). `workspaces.never_remember` (text, JSON string list) with defaults: passwords and keys, card and bank numbers, health details.
- Table `memory_changes`: id, workspace_id, agent_id, note_id, kind, action (`add`, `edit`, `forget`, `merge`), text, source_kind, source_id, written_by, user_scope (user id or null), status (`applied`, `held`, `rejected`, `undone`), library_version_id, dream_run_id (null), created_at, decided_by, decided_at.
- `@repo/db/shared`: `MEMORY_NOTE_KINDS`, `LEARN_LEVELS`, `MemoryNote`, `MemoryChange`. Add `memory_note` to `NEEDS_YOU_KINDS` with its heading.
- `@repo/services/memory` with `list`, `add`, `edit`, `forget`, `decide`, `undo`, `changes`, `rules.get`, `rules.set`. Stubs. Wire and mount `memory`.

## Check

- Migration applies locally and on a copy of staging data.
- `router.test.ts` knows the router. The format doc has one full example file.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/ME.1-memory-contract (v4 controller session).
