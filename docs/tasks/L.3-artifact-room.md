---
id: L.3
title: Realtime artifact room
milestone: L
size: L
status: review
depends_on: [L.1, L.2]
branch: t3/implement-artifact-room
lane: worker
executor: codex
---

## Scope and check

**L.3 `ArtifactRoom`.** Scope: the Durable Object with `withYjs` and hibernation, ticket check, read-only roles, name and colour overwrite on awareness, update rows, compaction, chunked snapshots, size cap, connection expiry and renewal, the RPC interface, agent presence publishing, checkpoint to R2 through a port. Check: tests for R1.6, R1.10 to R1.13, R1.18 and R1.21 against a local Durable Object; the hibernation check of R1.14.

## Log

- 2026-10-27: Queued for the user-authorized implementation of all four live artifacts phases using Sol and Terra worktrees. Commit each substantial completed task. Track validation gaps explicitly.

- 2026-10-27: Sol dispatched room using merged engine and reviewed spike. Must use connection-unique awareness IDs, authoritative validation before Yjs update application and fresh authorization at admission/renewal; service durable invalidation fix is underway separately.

- 2026-10-27: Merged bounded room 4b859af2; independent security/persistence review pending. Production adapters and staging remain gates.
