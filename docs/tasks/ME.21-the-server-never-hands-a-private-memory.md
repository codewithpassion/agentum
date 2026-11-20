---
id: ME.21
title: "The server never hands a private memory file to a working copy"
milestone: ME
size: S
status: todo
depends_on: []
branch: null
lane: services-library
executor: claude
---

From the ME gate review, round 2 (`docs/reviews/ME-2.md`, MF-2). This was ME's second and last gate round, so ME closes when ME.20 and ME.21 merge. Private notes stay with their person (Dom, 19 Nov 2026).

## Scope

In `apps/web/src/server/routes/run-library.ts`, make the handlers that `registerLibraryRoutes` mounts refuse `agents/*/memory/private/**` on list, stat and read. Both prefixes, `/api/runs/:id/library` and `/api/session/library`, share them. List leaves those entries out, and stat and read answer not found. No working copy needs the file, because every run gets its private notes from its prompt. Old daemons then cannot receive it, whatever their version. Leave the prompt's reader, which reads through the library service, and the platform MCP library tools as they are, since neither writes to a shared disk. Change ME.15's Dom step so upgrading machines is only about cleaning copies that already hold a file.

## Check

Route tests: a run that passes the private-notes rule for A gets no `private/<A>.md` when it lists `memory/`, and gets not found on stat and read of that path, on both prefixes. The same run still has A's notes in its launch context. The VM sync and daemon tests still pass. `bun run check && bun run test && bun run build` pass, and `cargo test` in `apps/agentum`.

## Log
- 2026-11-21: added from the ME gate review, round 2.
