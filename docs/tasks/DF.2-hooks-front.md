---
id: DF.2
title: Hooks front Worker that runs app endpoints
milestone: DF
size: L
status: in_progress
depends_on: [AE.1]
branch: DF.2-hooks-front
lane: web
executor: codex
---

Spec: `docs/v3/hooks-front.md`.

## Check
- Gate first: a real two-Worker Miniflare measurement (front with the loader and a service binding to a main Worker) of cold and warm calls, recorded in the Log. If a cold call doesn't answer well under 1 s, stop and report.
- Tests: an endpoint answers from the front without calling the main Worker when the app uses neither AGENTUM nor outbound; `ctx.waitUntil` work runs after the answer; AGENTUM calls and outbound requests (with secret filling and the host allowlist) reach the main Worker over the binding and work; unknown or disabled endpoints give 404; rate limits apply; the access log row (status, duration) and app errors are written; the main Worker's RPC entrypoint isn't reachable over HTTP.
- `bun run check && bun run test && bun run build` (the new app included in the workspace scripts and CI), then the bundle grep for `drizzle` in `apps/web/dist/client`.

## Log
