# A.14 review: phase 1 local end-to-end check

Run on `vite dev` at port 3214 from the A.14 worktree, signed in with dev login, local D1 and R2, local Browser Run (`CI=1`). Chromium 1243 through agent-browser and Playwright, Firefox 156 through puppeteer (WebDriver BiDi). Two agents in the Dev Workspace: "Faux Maker" (model `faux`, a scripted model that calls the tool named in the prompt) and "Real Maker" (Sonnet 5.5, Anthropic key from `.env.local` saved as the workspace key). Both on the `cloud` runtime, so every artifact call below went through the cloud isolate's MCP bridge.

## Verdicts

Round 1 (8dfd76ec): must-fix. The phone share sheet and history sheet kept shadcn's 28 px close button, so R1.26 did not hold as written. Fixed with a 40 px close button (`sheet-close.tsx`, `showCloseButton={false}`). Nits fixed: header comment, `.sr-only` and task-list CSS for GFM output, two more doc tests (task lists, inert HTML and `javascript:` links inside tables).
Round 2 (9825b1f8, fix commits only): clean. Two nits: the new close button is now the first tabbable element in the sheet, so focus starts on Close; and the check line below needed a commit to point at (it is 9825b1f8).

## Evidence per requirement

R1.1, R1.5: three artifacts made from web chat sessions (page, doc, dashboard with `data.json`) started as `private`, owner Dev User, "made by Faux Maker in a task". A later one by Real Maker the same.
R1.2, R1.3 (restore half): update made v2, restoring v1 from the history sheet made v3 with v1's files, `artifact.restored { fromVersion: 1, version: 3 }`.
R1.7 (cloud isolate only): `artifact_create`, `artifact_update` and `artifact_test` ran from the cloud isolate with the faux and the Sonnet model. The Linux VM, Managed Agents and machine runtimes were not run here (A.11 on staging).
R1.12: `artifact_test` on the dashboard (desktop) and doc (phone) returned console errors (none), failed requests (none) and the page text as text; the PNG landed in `agents/<slug>/tasks/<runId>/artifact-test-<v>-<viewport>-<ms>.png` (library write event). The desktop run set the card thumbnail (shown on `/artifacts` and the phone card); the phone run does not, by design (`artifact-ports.ts`). The Sonnet run used it unprompted, read the result, and wrote "both passed `artifact_test`".
R1.13: no `events` row and no line in the dev server log contains `hm_view_` or `hm_share_` after the whole run.
R1.18, R1.19: see the probe section.
R1.21b: the doc renders in the sandbox; raw `<script>` in the markdown shows as text and does not run. Tables did not render (pipes shown as text). Fixed, see fixes.
R1.22: the card appears in the thread while the run streams (no reload, first task) and again after a reload, with a live iframe preview on desktop (`sandbox="allow-scripts allow-forms"`, the dashboard's relative `fetch("data.json")` works) and the thumbnail at 390 px. Click-to-interact overlay present ("Interact with ...").
R1.23: the task view's Artifacts slot lists the artifacts the run published (one row for the dashboard run, two for the Sonnet run).
R1.24: `/artifacts` lists what the viewer may open. Kind filter "Doc" gave 1 of 5, "Shared by link" gave only the shared one, "Made by" People gave 0 and Agents gave all.
R1.25: `/a/<id>` shows title, owner, "made by agent in a task" link, version picker, Share, and a menu with full screen, version history, copy link, download, audience and delete. `?v=1` opened v1 and the picker followed. The history sheet lists versions with View and Restore (confirm step). Rename by clicking the title, audience from the menu (both events written). Delete asks for confirmation, soft-deletes and wrote `artifact.deleted`. Download returned a zip with the right filename.
R1.26: at 390 x 844, no sideways scroll (`scrollWidth == clientWidth`) on `/artifacts`, `/a/<id>` (page, dashboard and doc), the share sheet, the access log tab, the history sheet, the "more" menu, `/s/<token>`, the dead-link page and `/settings/artifacts`. Control heights measured by script. Before the fixes the viewer title (rename) button was 20 px and the thread card Open link 28 px; both are 40 px now. The sheets' Close buttons were 28 px (shadcn) and are 40 px now, and the `/artifacts` "Shared by link" label is 40 px on phones. Still under 40 px, all outside the artifact UI: the app shell header (logo, user menu, theme button) and the Show more / Stop task / Send / Attach / Open in library controls of the existing task page. The version picker is not in the phone viewer bar; history's View button covers it.
R1.27: three links made (7 days following latest, 1 day pinned to v3, both from the dialog). Copy puts the full URL on the clipboard ("Link copied") any time after creation.
R1.28: opened in a second browser profile with no cookies: the page shows the artifact in the share frame with "Shared from <workspace> on Harbourmaster", "Content is user-generated and unverified." and "Opens of this link are logged."; same at 390 px. The workspace name here is the Clerk org id, because local workspace rows are created with `name = clerkOrgId` (`workspaces.ts` `forOrg`); see steps for Dom.
R1.29: revoke, reopen: "This link is not available." (page) and 404 `{"error":"This link is not available."}` from `POST /api/share/<token>/open`, byte for byte the answer for an unknown token (checked with curl). Switching "Allow link sharing" off in Settings gave the same page; switching back on restored the pinned link. Setting `expires_at` into the past gave the same page. The 1-hour token tail was not timed.
R1.30: not run, one signed-in user. Covered by A.3's tests.
R1.31: one `artifact_views` row per open: surfaces `viewer`, `thread`, `test` and `share` all present. Link rows carry `127.0.0.0/24` (local; no full IP anywhere), a 64-char visitor hash, country, city, network and user agent. The access log tab shows them (Time, Who, Place, Network, Browser, Outcome) with the "Link created ..." label per link, and at 390 px as stacked cards.
R1.32: rows with outcomes `revoked`, `disabled` (links off) and `expired` exist and show as "Link revoked", "Links off" in the log.
R1.33: not run (the minute tick runs on the production Worker only). Covered by unit tests.
R1.34: events written with `actor_kind=user` and the signed-in user for restore, rename, audience change, link create, link revoke, links switch (both ways) and delete.
R1.35, R1.36: not run here (A.6 route tests; A.11 on staging).
Data files in the share dialog: the dashboard's dialog lists `data.json 1 KB`.

## After merging v3/artifacts (B.6, B.7)

Merged `v3/artifacts` (5a47d005) and re-ran on the merged tree: the probe in Chromium and Firefox, framed and direct (same counts, 0 failed, no API requests from content frames, iframe `sandbox="allow-scripts allow-forms"` with the nonce `name` set); viewer pages for a page, a dashboard and a doc; the thread card (live preview on desktop, thumbnail at 390 px); the share page at 1280 and 390 px; the sheets at 390 px. No new failures. `bun run check && bun run test && bun run build` pass at 9825b1f8 (the 40 px label change came after the browser re-runs and was measured on its own). One services test (`an hour of never-claimed runs stays bounded...`) timed out at 60 s in one full run while the machine's load average was about 29; it passes alone and in the later full run.

## Probe (R1.19), real server

`tmp/A.14/probe.html` published as an artifact through `artifact_create` from the Faux Maker run (a page plus `data.json`), then opened framed (viewer page, signed in) and directly (content URL with a `test` token minted from `ARTIFACT_VIEW_KEY`, top-level) in Chromium 1243 and Firefox 156. The browser holds the real Clerk cookies: `__session`, `__session_<id>`, `__client_uat`, `__clerk_db_jwt` etc., all `Path=/`, none HttpOnly, `__session` SameSite=Lax. So the parent page can read them and the probe has something to steal.

| Browser | Mode | Checks | Failed | CSP violation events |
|---|---|---|---|---|
| Chromium | framed | 18 | 0 | 4 |
| Chromium | direct | 15 | 0 | 4 |
| Firefox | framed | 19 | 0 | 4 |
| Firefox | direct | 16 | 0 | 5 |

The checks: `document.cookie` read and write throw, `window.origin` is `null`, `indexedDB.open` throws, `localStorage` is the bridge's stand-in with no app data, parent DOM and globals and top location unreachable, top navigation throws, service worker registration fails, `prompt()` returns null with no dialog, `window.open` returns null with no popup, credentialed `fetch` to `/api/health` and to `/api/trpc/artifacts.list` and a fetch of another artifact's path all fail (`TypeError`, `connect-src` violations), a form submit to `/api/health` is blocked (`form-action` violation) and the page stays. Controls: `data.json` loads, the bridge handshake completes framed (`viewer: member`) and is `null` direct. The driver saw zero requests to `/api/*` from the content frames in all four runs, no dialogs and no popups. The iframe's sandbox attribute was exactly `allow-scripts allow-forms`. A top-level open of the content URL with a member token redirected to `/a/<id>` in both browsers (R1.16). A.4's negative control (same probe without the wrapper leaked) still stands.

Not tested: Safari, and the member-token redirect in a browser that sends `Sec-Fetch-Dest: document` differently.

## Fixes

1. `apps/web/src/server/artifact-content/doc.ts`: GitHub tables, strikethrough and task lists in doc artifacts (`remark-gfm`, one new dependency). Agents write tables; the viewer showed pipes. Test added.
2. `apps/web/src/components/artifacts/share-dialog.tsx`, `link-list.tsx`: the 8-column link table pushed the dialog past its width, clipping the audience buttons and the Revoke button. Added `min-w-0` to the body, widened the dialog to `sm:max-w-5xl`, truncated the creator id.
3. `viewer/viewer-bar.tsx`, `thread-card.tsx`: 40 px tap height on phones for the rename button and the card's Open link.
4. `sheet-close.tsx`, `share-dialog.tsx`, `version-history-sheet.tsx`, `artifacts-filters.tsx`: 40 px sheet close buttons and checkbox label on phones (round 1).
5. `routes/a.$artifactId.tsx`: deleting lands on `/artifacts` (it went to `/desk`, A.8's nit now that A.9 is in).

## Found and left

- "Created by" in the link list shows the user id (`user_...`), not a name; the share row only carries the id.
- Local workspace name is the Clerk org id, so the share frame says "Shared from org_...". Production and staging rows may already have names.
- Following up a finished faux run with a second message answers `echo:` (the scripted model sees an empty prompt). Dev-only; the real model followed up fine in A.9's flow, not retested.
- Sonnet once called a tool named `artifact_create_placeholder_skip`, got "not available", and carried on with `artifact_create`. A model quirk, no code.
- The `/s/<token>` and dead-link routes log TanStack's "notFoundError ... no notFoundComponent" warning on the server.
- Settings sub-nav scrolls sideways on phones (existing page).

## Steps for Dom

None for the demo. For a nicer link page, check that the workspace row's `name` is set in each environment.
