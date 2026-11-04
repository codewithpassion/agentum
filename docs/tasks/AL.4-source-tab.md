---
id: AL.4
title: Source tab on the artifact page
milestone: AL
size: S
status: done
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
- 2026-11-05: Codex added artifacts.files and artifacts.readFile and the Source tab (217b13cb). The tab bar moved into ArtifactTabs. Controller review: same reader and version rules as Download, no blob keys or hashes in the listing, truncation in the router at 512 KB. Merged.
