---
id: L.6
title: Speaker identity and thread authors
milestone: L
size: L
status: todo
depends_on: [L.1]
branch: null
lane: services
executor: codex
---

## Scope and check

**L.6 Speaker envelope, Slack names and thread authors.** Scope: build the envelope in the services for artifact sessions and multi-person Slack threads; a `startForGuest` path in the runs service that takes a `GuestGrant`, since `deriveSubject` takes only a `Principal` (`packages/services/src/runs/subject.ts`), and sets actor kind `guest` and `scope_artifact_id` (its use by guests ships in phase 3, the path and its tests land here); the instructions block in `agent-prompt.ts`; keep the actor in `foldThread` and `applyFrame`; author display data for the thread UI. Check: tests for R1.32 to R1.35, including a forged envelope in message text.

## Log

- 2026-10-27: Queued for the user-authorized implementation of all four live artifacts phases using Sol and Terra worktrees. Commit each substantial completed task. Track validation gaps explicitly.
