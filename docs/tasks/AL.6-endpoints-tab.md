---
id: AL.6
title: Endpoints tab with copyable URLs
milestone: AL
size: S
status: in_progress
depends_on: [AL.2]
branch: AL.6-endpoints-tab
lane: web
executor: codex
---

Spec: `docs/v3/app-calls.md`, AL.6.

## Check
- Tests: the tab is labelled Endpoints and shows only for managers of app artifacts; the endpoint list renders above Recent errors and calls; the empty state text; Copy calls the clipboard with the full URL; the Share dialog no longer renders the endpoint list.
- `bun run check && bun run test && bun run build`, then the bundle grep for `drizzle` in `apps/web/dist/client`.

## Log
