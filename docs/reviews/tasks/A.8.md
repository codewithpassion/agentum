# A.8 review: framed viewer, artifact frame and share page

## Verdicts

Round 1 (0afc400): must-fix. After a restore the iframe kept the old content, and four phone controls were under 40 px (menu rows, the "Open the task" link, the rename input).
Round 2 (6398ee2b, fix commit only): clean.

## What was built

`frame-bridge.ts` holds the frame side of the bridge with no DOM, so bun tests drive it with fake events (port handoff, `event.source` check, schema rejection, open-link confirm, load-without-initialize blanking, handler table for phase 2). `artifact-frame.tsx` wraps it with the sandboxed iframe, the open-link confirm dialog and the "This artifact tried to leave its page" warning with Reload. `/a/$artifactId` and `/s/$token` are top-level routes. `hooks/use-full-bleed.ts` and a few lines in `__root.tsx` drop the site header and footer on those two routes.

Bridge contract A.4's `bridge.js` must match: the page posts `ui/initialize` to `window.parent` with `postMessage`; the frame answers on the same window with the JSON-RPC result `{ theme, viewer, version }` and transfers one `MessagePort` (`event.ports[0]`); every later message goes through that port. A new initialize after an iframe `load` gets a fresh port. A repeat initialize over a live port is refused.

## Browser check

Not run. A.2, A.3 and A.6 were not in `v3/artifacts` when the units were in, so `artifacts.get`, `open` and `/api/share/:token/open` do not answer yet. The browser check for R1.25, R1.26 and R1.28 at 1280 x 800 and 390 x 844 moves to A.14. The component tests, `bun run check`, `bun run test` and `bun run build` pass, and the bundle grep for `drizzle` is empty.

## Nits left

- Restoring while viewing `?v=n` navigates before the invalidate finishes, so the open effect runs once more for the old current version and writes one extra view row.
- `dropPendingLink` sets state during unmount cleanup. Harmless.
- A load right after a `ui/initialize` from the old document does not blank (counter is per load, not per document).
- The 2 s grace lets a navigated page show for up to 2 s before blanking.
- Handler error messages go back to the page verbatim. Map them to a generic text when phase 2 handlers arrive.
- `onSizeChanged` is not wired from `ArtifactFrame` props. The thread card (A.13) gets no size handling.
- Reload and returning from the Access log tab reuse the same `contentUrl`; nothing re-opens after `expiresAt`.
- Delete lands on `/desk`. Switch to `/artifacts` once A.9 is in.
- The login redirect has no return path (same as `_app`).
- `requestFullscreen` on a div is unsupported on iPhone Safari (error toast).

## Beyond scope, for the controller

- The Download menu item points at `/api/artifacts/:id/download?version=n`. No task provides that route or any file listing. Needs a route (zip built server side from the manifest) or an `_hm/manifest.json` served by the content route.
- PRD gap (R1.21, section 3): any outside page loaded in the iframe can send its own `ui/initialize` and be accepted, since all sandboxed documents share origin `null`. Today the port only carries theme, viewer and version. Phase 2 `tools/call` and `storage/*` need their own gate, and the PRD residual risks should say so.

## Steps for Dom

None. Run the browser check in A.14.
