---
id: AL.6
title: Endpoints tab with copyable URLs
milestone: AL
size: S
status: done
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
- 2026-11-05: Codex renamed Calls to Endpoints, put EndpointSettings at the top of the tab with the new empty state and selectable URLs, and removed it from Share (8a33b5c7). Controller review: three small file changes, tests cover order, copy and Share removal; check, test, build and bundle scan pass.
