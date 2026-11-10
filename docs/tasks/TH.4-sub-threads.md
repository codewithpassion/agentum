---
id: TH.4
title: Hand-offs and helpers show as sub-threads
milestone: TH
size: M
status: in_progress
depends_on: [TH.2, TH.3]
branch: task/TH.4-sub-threads
lane: web
executor: claude
---

From the 10 Nov 2026 review. Delegated work is disconnected from the conversation that started it, and sub-threads are read-only.

## Scope

- A thread lists its child threads (hand-offs and subagents) with status, indented in the list, and a child links back to its parent.
- A hand-off started from a private chat stays private, as subagents already do (`apps/web/src/server/mcp/ports.ts`, `packages/services/src/sessions.ts`).
- A person can reply in a sub-thread, through `StartRunOptions.sessionId` on a trusted path.
- The parent is woken when a hand-off child finishes, reusing the subagent wake.

## Check

- Service tests for visibility of a hand-off from a private chat, and for the wake.
- On staging: an agent hands off, the child shows under the parent, and a reply in the child works.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-10: added from the 10 Nov review, after Dom's decisions (members are trusted with credentials, the assistant may approve skills, assistant conversations share the thread list and are marked).
- 2026-11-10: dispatched to a Sonnet implementer on task/TH.4-sub-threads. Lane rule relaxed for this run; files checked against the other running tasks.
