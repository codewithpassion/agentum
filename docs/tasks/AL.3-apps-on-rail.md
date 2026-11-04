---
id: AL.3
title: Apps on the rail and in Find
milestone: AL
size: XS
status: done
depends_on: []
branch: AL.3-apps-on-rail
lane: web
executor: codex
---

Spec: `docs/v3/app-calls.md`, AL.3.

## Check
- Rail and Find tests cover the Apps link.
- `bun run check && bun run test`.

## Log
- 2026-11-05: Codex added Apps to the rail footer (four columns, footer pulled out as RailFooter for a render test) and to Find (9e1454ff). Controller review: RailLink takes the query string; check, test, build and bundle scan pass. Merged.
