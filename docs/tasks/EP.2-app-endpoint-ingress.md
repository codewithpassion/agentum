---
id: EP.2
title: Public endpoint route for app artifacts
milestone: EP
size: M
status: todo
depends_on: [EP.1]
branch: null
lane: worker
executor: codex
---

Spec: `docs/v3/app-endpoints.md`, section "Endpoints". Read `apps/web/src/server/app-gateway/` first: the route reuses the gateway, the runtime and the header rules.

## Scope
- Approving an `endpoint` grant makes the `artifact_endpoints` row for (artifact, name) when there is no active one.
- Route `ALL /hooks/:id/*` (and `/hooks/:id`), mounted like `/a2a`: before Clerk, outside `cookieGroup()` and `csrf()`. It resolves the row, then the artifact's live version, and requires an approved `endpoint` grant for the name on that version. Otherwise 404 with a fixed body.
- The app gets the request path after `/hooks/<id>`, the query and the raw body unchanged. Request headers are dropped as for other app requests, except `authorization`, which is kept. Response headers go through the existing allowlist and content headers.
- Viewer `{ kind: "endpoint", endpointId }`: shared storage read and write, `whoami()` answers `viewer: "endpoint"`, viewer storage and `callTool` are refused with `forbidden`. Outbound to approved hosts with secret placeholders works (the snapshot and test refusal for hosts does not apply).
- Rate limit per endpoint id plus IP prefix on the existing limiter (429 when over). An `artifact_views` row per call.
- UI in the artifact's settings: each endpoint's full URL with Copy, Disable or Enable, and Rotate (disables the row and makes a new id). Org admins and the artifact owner only, enforced in the service.
- The Needs you card for an `endpoint` grant says that anyone on the internet can call the address and the app's code must check who is calling. An `agent` grant card names the agent.

## Check
- Tests:
  - unknown id, a disabled row, a live version without the grant, and a pending grant each give 404;
  - an approved endpoint reaches the app with the raw body byte for byte and `authorization` kept;
  - endpoint viewer rights are as listed;
  - rotate gives 404 on the old id and 200 on the new one;
  - over the limit gives 429.
- A test with a real Dynamic Worker (as `real-worker.test.ts`) verifies an Ed25519 signature over the raw body in app code.
- Browser: in local dev, publish and approve an app with an endpoint, copy its URL from settings, curl it, disable it, curl again.
- `bun run check && bun run test && bun run build` pass.

## Log
