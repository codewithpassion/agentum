---
id: AL.1
title: Access log answers 500 for artifacts with views
milestone: AL
size: XS
status: done
depends_on: []
branch: AL.1-access-log-guestid
lane: services
executor: codex
---

Spec: `docs/v3/app-calls.md`, AL.1.

## Check
- A service test parses `views` output with `artifactsViewsOutputSchema`; it fails before the fix.
- `bun run check && bun run test`.

## Log
- 2026-11-05: Codex dropped guestId from listViews (f91c0631); new schema assertion failed before, passes after. Controller review: two-line fix, protocol unchanged. Merged.
