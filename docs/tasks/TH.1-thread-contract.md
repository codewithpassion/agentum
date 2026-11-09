---
id: TH.1
title: Sessions become threads, columns and service
milestone: TH
size: M
status: todo
depends_on: []
branch: null
lane: services
executor: claude
---

From the 10 Nov 2026 review. Contract task for TH: it alone changes `packages/db/src/schema` and generates the migration. A session is already a thread in the data, but it has no title, parent or ordering by activity.

## Scope

- `sessions` gains `title`, `pinned_at`, `archived_at`, `parent_session_id`, and an index for listing by `last_run_at`. Use the column names `assistant_conversations` uses. Add an index on `runs.parent_run_id`.
- `insertOnce` sets `parent_session_id` when a run has a parent run. The migration backfills it from `runs.parent_run_id`, and backfills `title` from the first message.
- Service: `list` orders by last activity with a cursor and filters by agent and archived; `main(agentId)` gets or creates the caller's main thread (`ui` origin, `externalKey = "main:<userId>"`); `rename`, `pin`, `archive`, `unarchive`; the existing `search` also matches titles.
- tRPC exposes all of these. Add mail, qa, a2a and artifact to `ORIGIN_VALUES`.

## Check

- Service tests for ordering, paging, main get-or-create under a race, parent set on hand-off and subagent runs, and visibility unchanged.
- `bun run generate` output committed, and migrations apply on a copy of staging data.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-10: added from the 10 Nov review, after Dom's decisions (members are trusted with credentials, the assistant may approve skills, assistant conversations share the thread list and are marked).
