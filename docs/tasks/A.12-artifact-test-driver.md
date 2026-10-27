---
id: A.12
title: artifact_test browser driver
milestone: A
size: M
status: done
depends_on: [A.1]
branch: task/A.12-artifact-test-driver
lane: worker-test
executor: claude
---

Spec: `docs/v3/artifacts-prd.md` (the PRD). A.1 holds every schema change, shared constant, protocol schema and seam; this task changes none of `packages/db/src/schema`, `packages/db/src/shared.ts` or migrations, and works against A.1's types. Integration branch: `v3/artifacts`.

Split out of the PRD's A.6 so it runs beside the other tasks.

## Scope
- `apps/web/src/server/artifact-test/driver.ts`: `runArtifactTest({ browser, url, viewport })` over the existing Browser Run driver (`apps/web/src/server/browser-run.ts`, `@cloudflare/playwright`). Viewports desktop 1280x800 and phone 390x844. Open the content URL (a test-token URL, so no redirect), wait for load plus a short settle, collect page title, console errors and warnings (CSP violations included), failed requests and 4xx/5xx responses, a text snapshot through `packages/services/src/browser/snapshot.ts`, and a PNG screenshot. Return them as data; saving the screenshot to the task folder and setting the thumbnail is A.6's adapter.
- A pure formatter that turns the result into the text the tool returns, capped in size.
- Don't edit `compose.ts`, `server.ts` or the MCP package.

## Check
- Unit tests with a fake browser for collection, formatting and caps.
- A real run against local Browser Run (the `BROWSER` binding in `vite dev`, if local mode supports it) on a small HTML page served locally, noted in `docs/reviews/tasks/A.12.md`; if local Browser Run isn't available, say so there and leave it for A.14.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: planned (controller).
- 2026-10-27: dispatched.
- 2026-10-27: ready at 7a3c2a8, review clean after 1 fix round; local Browser Run needs CI=1 on vite dev; merged.
