---
id: AL.2
title: Calls tab for app endpoints
milestone: AL
size: M
status: done
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
- 2026-11-05: Codex added status_code and duration_ms (migration 0045), artifacts.calls and artifacts.appErrors (owner or admin), and the Calls tab (dcc22c7a). Controller merge: resolved with AL.1 and AL.4, Calls joins ArtifactTabs, dropped count shown only when above zero. Full check and test pass on the integration branch.
