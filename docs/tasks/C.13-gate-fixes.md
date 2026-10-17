---
id: C.13
title: C gate fixes - MCP sessions and the next waiting run
milestone: C
size: M
status: in_progress
depends_on: [C.11]
branch: task/C.13-gate-fixes
---

The two must-fix findings from the C milestone gate, round 1 (`docs/reviews/C-1.md`, items 1 and 2).

## Scope

1. The MCP bridge (`apps/web/src/server/pi-run-mcp.ts`) treats every server as stateless. Keep the `Mcp-Session-Id` from each server's `initialize` reply, send `notifications/initialized`, send the session id on later `tools/list` and `tools/call` requests, and initialize again on a 404 or 400 for a lost session. Connectors that use stateful Streamable HTTP must keep their tools in cloud runs.
2. A follow-up message to a busy cloud agent waits 60 to 120 s for the sweep. When a cloud run ends (done, failed or cancelled), offer the agent's next waiting run right away, as managed runs do with `offerNext` in `packages/services/src/managed/service.ts`. Keep the rule of one running run per agent, the same as machine and managed runs. Real steering into a busy session is out of scope. Amend nothing in C.3's task file, because the controller records that decision.

## Check

A test with a fake MCP server that requires the session id: tools list and call succeed, and a lost session is re-initialized. A test that a second message queued while a cloud run is busy starts as soon as the first run ends, with no sweep. Live on a local dev server with the workspace key from `apps/web/.env.local` in the local dev database: two quick messages to one cloud agent both get replies within a few seconds of each other, and the stub connector from `scripts/dev/stub-mcp.ts`, run in stateful mode if it supports one (or a small stateful variant added next to it), works in a cloud run. `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-17: added from the C gate round 1; dispatched on task/C.13-gate-fixes.
