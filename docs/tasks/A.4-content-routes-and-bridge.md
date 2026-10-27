---
id: A.4
title: Sandboxed content routes and bridge script
milestone: A
size: L
status: todo
depends_on: [A.1]
branch: null
lane: worker-content
executor: claude
---

Spec: `docs/v3/artifacts-prd.md` (the PRD). A.1 holds every schema change, shared constant, protocol schema and seam; this task changes none of `packages/db/src/schema`, `packages/db/src/shared.ts` or migrations, and works against A.1's types. Integration branch: `v3/artifacts`.

## Scope
- A Hono route module in `apps/web/src/server/artifact-content/` for `GET /a/<uuid>/c/<token>/*` (PRD section 3 "The design" and "HTTP routes"): verify the view token with `view-token.ts` (key passed in), check it names this artifact, read the version manifest and blobs from the `FILES` R2 bucket only (no D1), serve the entry for an empty path, content types from the A.1 map.
- One header wrapper that every response passes through, success, error, redirect and 304 alike: the full CSP with `<base>` and `frame-ancestors` built from the request origin, `nosniff`, `no-referrer`, `noindex`, `Cache-Control: private, max-age=300`, `Access-Control-Allow-Origin: *` without credentials.
- Refusals: `Sec-Fetch-Dest: document` with a member or link token answers 302 to `/a/<uuid>` (test tokens exempt); `Service-Worker: script` answers 403; bad, expired or wrong-artifact token answers 401 with no bytes; missing path 404.
- `HTMLRewriter` injects `<script src="_hm/bridge.js">` first in `<head>` of HTML entries. `_hm/bridge.js`: the page side of the bridge (JSON-RPC 2.0 over a `MessageChannel` port received on `ui/initialize`, size-change notification, `ui/open-link`, a small `window.harbourmaster` API) and in-memory `localStorage`/`sessionStorage` stand-ins. Message shapes from `@repo/protocol/artifacts`. Leave a clear extension point for phase 2's `tools/call` and storage calls.
- `_hm/doc.html`: the markdown viewer for `doc` artifacts, rendering `index.md` inside the sandbox (R1.21b). A vendored or bundled renderer served from `_hm/`, never from a CDN the CSP doesn't list.
- Export a function that mounts the routes on a Hono app, with the bucket and key as parameters. Do not edit `server.ts`; A.6 mounts it.

## Check
- Route tests for R1.14 to R1.17 over every status code, asserting the exact CSP on each.
- A browser probe for R1.19: mount the routes in a small local harness (a test Worker or a temporary dev entry under `tmp/A.4/`, not committed into the app) serving a probe artifact, and in Chrome and Firefox (agent-browser, or Playwright with the preinstalled Chromium plus Firefox if available) confirm, framed with `sandbox="allow-scripts allow-forms"` and opened directly, that `document.cookie`, `localStorage` and the parent DOM are unreachable, a credentialed fetch to `/api/trpc` fails, service worker registration, top navigation, form submit and `prompt()` fail. Record results in `docs/reviews/tasks/A.4.md`.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: planned (controller).
