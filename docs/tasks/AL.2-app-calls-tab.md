---
id: AL.2
title: Calls tab for app endpoints
milestone: AL
size: M
status: in_progress
depends_on: []
branch: AL.2-app-calls-tab
lane: web
executor: codex
---

Spec: `docs/v3/app-calls.md`, AL.2.

## Check
- Migration generated and committed with `migrations/meta/`.
- Tests: the route records status and duration; `calls` pages, filters to endpoint rows, and refuses members who can't manage; output parses with the protocol schema; the tab renders rows, errors and the empty state, and shows only for apps.
- `bun run check && bun run test && bun run build`, then the bundle grep for `drizzle` in `apps/web/dist/client`.

## Log
