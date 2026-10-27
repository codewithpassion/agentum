---
id: L.3
title: Realtime artifact room
milestone: L
size: L
status: todo
depends_on: [L.1, L.2]
branch: null
lane: worker
executor: codex
---

## Scope and check

**L.3 `ArtifactRoom`.** Scope: the Durable Object with `withYjs` and hibernation, ticket check, read-only roles, name and colour overwrite on awareness, update rows, compaction, chunked snapshots, size cap, connection expiry and renewal, the RPC interface, agent presence publishing, checkpoint to R2 through a port. Check: tests for R1.6, R1.10 to R1.13, R1.18 and R1.21 against a local Durable Object; the hibernation check of R1.14.

## Log

- 2026-10-27: Queued for the user-authorized implementation of all four live artifacts phases using Sol and Terra worktrees. Commit each substantial completed task. Track validation gaps explicitly.
