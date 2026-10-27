---
id: L.1
title: Live artifacts contract
milestone: L
size: L
status: in_progress
depends_on: [L.0, L.P]
branch: null
lane: db
executor: codex
---

## Scope and check

**L.1 Live artifacts contract.** Scope: kinds, view surfaces, actor kind `guest`, session origin `artifact`, `runs.scope_artifact_id`, the new tables of the data model (phase 3 guest tables included, so the schema changes once), constants and event types; migration with `migrations/meta`; `packages/protocol/src/live.ts` with the speaker envelope, room ticket claims, awareness entry and comment anchor schemas. Check: `schema.test.ts` and `foreign-keys.test.ts` cover the tables, the `events` triggers survive, protocol tests parse every schema, `bun run check && bun run test && bun run build` pass.

## Log

- 2026-10-27: Queued for the user-authorized implementation of all four live artifacts phases using Sol and Terra worktrees. Commit each substantial completed task. Track validation gaps explicitly.

- 2026-10-27: Sol begins stable schema/protocol contracts using the partial spike evidence; integration remains gated on completed L.0. No room implementation depends on an unverified relay assumption.
