---
id: L.4
title: Live artifacts service and router
milestone: L
size: L
status: todo
depends_on: [L.1]
branch: null
lane: services
executor: codex
---

## Scope and check

**L.4 Live artifacts service and router.** Scope: `packages/services/src/live-artifacts/` factory over `{ db, atomic, blobs, clock, events, rooms, artifacts }`: create live kinds, join and tickets, convert from `doc`, comments and threads with anchors, ask (start a run in the artifact session with the envelope from L.6), `visibleSessions` and `findSession` rules for origin `artifact` (everyone who can open the artifact sees its session, and several people may post to it), agent changes and revert, checkpoint into `artifact_versions`, restore; `live-artifacts-router.ts`. Check: unit tests for R1.1, R1.3, R1.5, R1.7, R1.29 to R1.31, R1.36 and R1.37; router tests for 401 and 403.

## Log

- 2026-10-27: Queued for the user-authorized implementation of all four live artifacts phases using Sol and Terra worktrees. Commit each substantial completed task. Track validation gaps explicitly.
