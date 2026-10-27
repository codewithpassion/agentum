---
id: L.1
title: Live artifacts contract
milestone: L
size: L
status: done
depends_on: [L.0, L.P]
branch: t3/live-artifact-contract
lane: db
executor: codex
---

## Scope and check

**L.1 Live artifacts contract.** Scope: kinds, view surfaces, actor kind `guest`, session origin `artifact`, `runs.scope_artifact_id`, the new tables of the data model (phase 3 guest tables included, so the schema changes once), constants and event types; migration with `migrations/meta`; `packages/protocol/src/live.ts` with the speaker envelope, room ticket claims, awareness entry and comment anchor schemas. Check: `schema.test.ts` and `foreign-keys.test.ts` cover the tables, the `events` triggers survive, protocol tests parse every schema, `bun run check && bun run test && bun run build` pass.

## Log

- 2026-10-27: Queued for the user-authorized implementation of all four live artifacts phases using Sol and Terra worktrees. Commit each substantial completed task. Track validation gaps explicitly.

- 2026-10-27: Sol begins stable schema/protocol contracts using the partial spike evidence; integration remains gated on completed L.0. No room implementation depends on an unverified relay assumption.

- 2026-10-27: Contract 678636b5 merged, independent review and controller combined validation underway. Implementation reports package/script tests, types, build and boundary scan passed; stale spike lint failures are resolved in current main.

- 2026-10-27: Controller fixed independent review must-fix: required signed ticket colour plus rejection tests, 348 protocol tests pass. Combined root check/test/build previously passed; forward isolation gates assigned to L.4 and phase 3.
