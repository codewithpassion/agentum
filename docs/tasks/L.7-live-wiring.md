---
id: L.7
title: Live artifacts wiring
milestone: L
size: L
status: in_progress
depends_on: [L.3, L.4, L.5]
branch: null
lane: worker
executor: codex
---

## Scope and check

**L.7 Wiring.** Scope: build the live service in `composeWith`; merge the router; mount `/api/rooms/:artifactId` before Clerk; the `ArtifactRoom` binding and migration in three places; room and service ports; checkpoint on the tick for rooms that missed one; `artifact.live_checkpoint` in `STREAM_EVENT_TYPES`; MCP adapters. Check: route tests for the ticket path; an MCP round trip from a run token through `artifact_create` and `document_edit` to a room; `compose.test.ts` passes.

## Log

- 2026-10-27: Queued for the user-authorized implementation of all four live artifacts phases using Sol and Terra worktrees. Commit each substantial completed task. Track validation gaps explicitly.

- 2026-10-27: Starting production integration against merged room, ask factory, core, engine and tools. Must complete real adapters and durable processors; no stub acceptance.
