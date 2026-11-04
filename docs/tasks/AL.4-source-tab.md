---
id: AL.4
title: Source tab on the artifact page
milestone: AL
size: S
status: in_progress
depends_on: []
branch: AL.4-source-tab
lane: web
executor: codex
---

Spec: `docs/v3/app-calls.md`, AL.4.

## Check
- Tests: `files` and `readFile` refuse someone who can't open the artifact, follow the chosen version, and parse with the protocol schemas; the tab lists files in the spec's order, shows text, handles binary files, and shows for readers who can't manage.
- `bun run check && bun run test && bun run build`, then the bundle grep for `drizzle` in `apps/web/dist/client`.

## Log
