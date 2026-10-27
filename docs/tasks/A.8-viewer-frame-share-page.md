---
id: A.8
title: Framed viewer, artifact frame and share page
milestone: A
size: L
status: in_progress
depends_on: [A.1]
branch: task/A.8-viewer-frame-share-page
lane: web-viewer
executor: claude
---

Spec: `docs/v3/artifacts-prd.md` (the PRD). A.1 holds every schema change, shared constant, protocol schema and seam; this task changes none of `packages/db/src/schema`, `packages/db/src/shared.ts` or migrations, and works against A.1's types. Integration branch: `v3/artifacts`.

UI tasks run beside the backend tasks and code against the A.1 tRPC schemas. If the services and wiring (A.2, A.3, A.6) are already merged into `v3/artifacts` when the units are in, merge `v3/artifacts` and run the browser check against a local dev server (dev login, see CLAUDE.md). If not, the component tests and build are the check, and the browser check moves to A.14; say which in the review file.

## Scope
- Fill `apps/web/src/components/artifacts/artifact-frame.tsx` (A.1 stub): the iframe with exactly `sandbox="allow-scripts allow-forms"`, `referrerpolicy="no-referrer"`, `allow="clipboard-write"` (R1.18); the frame side of the bridge: on the first `ui/initialize` from the iframe's `contentWindow` transfer a `MessageChannel` port and talk only through it, validate every message with the A.1 zod schemas, answer with `{ theme, viewer, version }`, size changes, `ui/open-link` opens in a new tab only after the viewer confirms (R1.20); a `load` without a fresh `ui/initialize` blanks the iframe and shows "This artifact tried to leave its page" with Reload (R1.21). Keep a clear handler table so phase 2 adds `tools/call` and storage. Used by the viewer, the share page and the thread card.
- `/a/$artifactId` outside `_app` (PRD section 8 "Framed viewer"): 44 px top bar with title (rename for the owner), "by <owner> · made by <agent> in <task>" (task link only when visible), version picker with `?v=<n>` (R1.25), Share button opening `ShareDialog` (A.1 stub, A.10 fills it), menu with Open full screen, Version history, Copy link, Download (zip of the version's files, built client-side or through a route if the content route can't), Delete with confirm, audience switch for owner and admins. Version history sheet with View and Restore (confirm says it creates a new version). Access log tab rendering `AccessLog` (A.1 stub). Iframe fills `100dvh`. Phone layout: title, Share, menu (R1.26). Calls `artifacts.open` for the content URL.
- `/s/$token` outside `_app` (PRD section 8 "Share page"): thin bar with title, "Shared from <workspace> on Harbourmaster", "Content is user-generated and unverified.", "Opens of this link are logged."; the client calls `POST /api/share/:token/open` (A.6) and renders `ArtifactFrame` with viewer `link`; dead links show only "This link is not available." (R1.28 UI side).

## Check
- Component tests for the bridge frame handler: port handoff, schema rejection, `event.source` check, open-link confirm, load-without-initialize warning.
- Browser check at 1280 x 800 and 390 x 844 for R1.25, R1.26, R1.28 (see above for when it runs).
- `bun run check && bun run test && bun run build` pass; the bundle grep is empty.

## Log
- 2026-10-27: planned (controller).
- 2026-10-27: dispatched.
