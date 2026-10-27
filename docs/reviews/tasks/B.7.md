# B.7 review: bridge phase 2 (tools/call, storage, ui/message) and the nonce gate

## Verdicts

Round 1 (f545aebd): must-fix. The nonce was valid for the iframe's life and sat in `location.hash`, so an artifact could navigate to an outside page carrying it. Multi-page artifacts would blank. Link storage was missing.
Round 2 (5fe19be2, fix commit only): must-fix. A page with no `<head>`, or a script before it, ran before `bridge.js`.
Round 3 (a523671d, fix commit only): must-fix. UTF-16 HTML and a non-page `entry` (.svg, .xml) were served without the bridge, and the ETag was stale.
Round 4 (4f17c776, controller decisions only): must-fix, one item. The click listener that carries the nonce ran in the capture phase, so its `defaultPrevented` check never saw what the page did. Fixed in the next commit (decide in a bubble listener on `window`). That last fix was not reviewed again: the controller allowed one round beyond the usual two.

## What was built

Page side (`server/artifact-content/bridge.ts`): `window.harbourmaster.tools.call`, `storage.get/set/delete/list`, `sendMessage`, all promise-returning and waiting for the handshake. The nonce is read from `#hm=<nonce>` and sent in `ui/initialize`. Clicks on links to other pages of the same artifact append the nonce to the target.
Frame side: `frame-bridge.ts` ignores an initialize whose nonce is not the current one. `frame-calls.ts` has the handlers and two adapters (tRPC for members, `POST /api/share/:token/call` and `.../storage` for links) with fixed error texts, so no server text reaches the page. `artifact-frame.tsx` mints a nonce per iframe load, puts it in `src`, and builds the handlers. `content-ref.ts` reads artifact id and version id from the content URL.
Route: `injectBridge` puts the script before the first element of any page.
Services: `entry` must be .html, .htm or .md (manifest schema and upload). HTML files with a UTF-16 byte order mark are refused at upload. ETag suffix is `.b2`.
Fixture and test: `fixtures/live-dashboard.html` run end to end through the real page script, the real frame bridge and a real MessageChannel (`live-dashboard.test.ts`).

## Decisions and their limits

The nonce is defence in depth. The artifact's own script can read it (the address, `performance` navigation entries), so it only stops pages the artifact did not write from taking a port. The grants are the real boundary.
It lives as long as the frame. A page reloading itself keeps it, a click to another page of the artifact carries it. Navigations the bridge cannot see (GET form submits, `location.href = ...`, a click before the first handshake) land without it, and the frame blanks with Reload.
Link viewers: `tools/call` through the share route, storage reads of the shared area only through `POST /api/share/:token/storage` with `{ op: "get" | "list", key?, prefix? }` answering `{ result }` (get: `{ value }`, list: `{ keys }`, as the route returns them). B.6 built that route. A 502 from the call route (the granting person's side failed) reaches the page as a tool result with `isError: true`. Writes and the viewer area are refused on the frame. `ui/message` is refused unless the host passes `onMessage`, and no surface does yet.

## Nits left

- Carrying the nonce onto a link that has a fragment gives `page.html#top&hm=<n>`, so the browser does not scroll to `#top`.
- Hash-routed artifacts see `hm=<n>` as their first route, and an in-page `#section` link drops it, so a later reload blanks.
- `<base target="_blank">` is not honoured by the nonce carry.
- Stored manifests with a non-page entry now fail to parse on read (Bad manifest). Check staging and production for such versions.
- Restoring an old version with UTF-16 HTML still works (restore reads no bytes). The frame blanks such a page.
- Thread previews (`interactive={false}`) run live calls too. A preview could be read-only.
- No in-flight cap on member `tools/call` in the frame.
- `artifact-frame.tsx` gives a bare "Method not found" when no handlers can be built (unparseable member URL, link without a share token).
- `content-ref.ts` reads the version id from the unverified token claims. Adding the version id to the `artifacts.open` output would drop that coupling.
- Round 4's other nits (carry tests for `target="_self"`, BOM refusal tested on create only) stand.

## Beyond scope

- A route for the Download menu (A.8) is still missing.
- Multi-page navigation could be made robust by letting the frame hand out a fresh nonce for an in-folder URL it validates, but the opaque origin makes the target page indistinguishable from any other, so it was not done.

## Steps for Dom

None. Check the stricter `entry` rule against existing artifacts in staging before deploying.
