# A.4 review record

Sandboxed content routes and bridge script. Code in `apps/web/src/server/artifact-content/`: `routes.ts` (the mount function), `headers.ts` (CSP and the one header wrapper), `bridge.ts` (`BRIDGE_JS`, the page-side bridge and storage stand-ins), `doc.ts` (markdown viewer). Not mounted: A.6 calls `mountArtifactContentRoutes(app, { bucket, viewKey, workspaceId, nowSeconds? })`.

## Contract notes for A.6 and A.3

- The A.1 view token has no workspace id, but R2 keys start with it (`<ws>/artifact-manifests/<versionId>.json`). The route therefore takes `workspaceId(claims, env)` as a parameter and answers 404 when it returns null. A.6 must supply it (a small D1 lookup by `claims.artifactId`, which can be cached per isolate, or a `workspaceId` claim added to `viewTokenClaimsSchema` by A.1/A.3 and read back). The route itself never touches D1.
- `bucket(env)` returns anything with `get(key)` that gives `{ arrayBuffer, body, size }` (`env.FILES` fits). `viewKey(env)` returns the `ARTIFACT_VIEW_KEY` secret.
- Frame side (A.8): the page posts `ui/initialize` (id 1) to `window.parent` with target `*` and retries every 250 ms, up to 40 tries, until it gets a JSON-RPC result with id 1 carrying `event.ports[0]`. The frame must answer with the result and the transferred port in one `postMessage`, and ignore repeat initializes after the first. After that the page sends `ui/notifications/initialized` and `ui/notifications/size-changed` over the port.
- Entry that is markdown (`.md`) is served as a rendered page at the empty path and at `_hm/doc.html`. HTML entries get `<script src="_hm/bridge.js">` first in `<head>` (relative path adjusted for nested pages; appended at the end when a page has no `<head>`).
- Responses add `Vary: Sec-Fetch-Dest` so a cached redirect is never reused for a frame load.
- `ETag` on files, 304 supported. No Range support.

## Checks

- `bun test src/server/artifact-content` in `apps/web`: route tests over 200, 204, 302, 304, 308, 401, 403, 404, 405 and 500 asserting the exact CSP and the other headers on each; bridge tests running the real script against a fake window and the protocol schemas; doc tests.
- `bun run check && bun run test && bun run build`: pass; `boundary-lint` clean.

## Browser probe (R1.19)

A throwaway harness (not committed, `tmp/A.4/harness.ts`) mounted the routes with an in-memory bucket next to a fake app that sets `__session=SECRET-SESSION-JWT; Path=/; SameSite=Lax` (script-readable, like Clerk's) and serves `/api/trpc/ping`, `/api/form`, `/secret.png`. A probe artifact ran 15 to 19 checks and reported back through a path inside its own content folder. Run in Chrome 153 (Playwright's Chromium) and Firefox 156 (puppeteer, WebDriver BiDi), each framed with `sandbox="allow-scripts allow-forms"` in a page that holds a script-readable cookie, a `localStorage` secret and a global, and opened directly with a `test` token (document loads with a member token answer 302, checked too).

Every check passed in both browsers, framed and direct:

- `document.cookie` read and write throw `SecurityError`; `window.origin` is `"null"`; `indexedDB.open` throws; the page's `localStorage` is the in-memory stand-in and holds none of the app's data.
- Framed: `window.parent.document`, `window.parent.<global>`, `window.top.location` reads and `window.top.location = ...` all throw `SecurityError`; the parent's location, cookie and storage were unchanged afterwards.
- `fetch('/api/trpc/ping', { credentials: 'include' })` fails with `TypeError` (CSP `connect-src`), a fetch of another artifact's path fails, an `<img>` of `/secret.png` is blocked, a form `submit()` to `/api/form` is blocked by `form-action 'none'`. The harness logged zero requests to `/api/*`, `/files/*` and `/secret.png` in all four runs, so no cookie ever left.
- `navigator.serviceWorker.register` fails (`SecurityError`); `prompt()` returns null with no dialog event; `window.open` returns null (Chrome) or throws (Firefox); no popup.
- Controls: the bridge handshake completes framed (`ui/initialize` result, `initialized` and `size-changed` arrive in the parent, a `ui/open-link` round trip resolves); opened directly `harbourmaster.ready` resolves null; a relative `fetch('data.json')` works (CORS wildcard).
- Negative control: the same probe served without the wrapper, same origin as the fake app, sent `__session` to `/api/trpc/ping`, `/secret.png` and `/api/form`. So the probe does detect a leak.
- Clerk cookie path: not checked here (no Clerk in the harness). A.11 still needs to confirm in devtools that `__session` is `Path=/` and what its SameSite is.
- Not tested: Safari (not drivable here), `react-dom/server` inside workerd (the build bundles it; the doc viewer ran only under bun).

## Review rounds

(filled in below)
