# A.12 artifact_test browser driver: review

## Verdicts

Round 1 (e1108d8): no code must-fix. The only must-fix was this missing review note with the real Browser Run run. Fixes applied in the follow-up commit: reuse `redactText` from `@repo/services/events/scrub` instead of a local regex, drop the duplicate title call (the title comes from the snapshot), close the browser when `newPage` fails, add the "and N more" line for links, add token tests for title, load error, request URLs, page text and links, and make the `runArtifactTest` docstring honest about a page that can't be read at all.

## Real run against local Browser Run

Local mode works. In `apps/web`, `CI=1 bunx vite dev --port 3112` starts miniflare's local Browser Run, which downloads and launches Chrome. `CI=1` is needed on this host: without it Chrome fails with "No usable sandbox" because miniflare only adds `--no-sandbox` when `CI` is set.

A temporary route (not committed) served a small HTML page locally with a CSP, a 404 stylesheet, a `console.error`, a `console.warn`, a late thrown error and a script from a blocked host, then called `artifactTestBrowser(env.BROWSER)` and `runArtifactTest` against it with a fake `hm_view_` token in the query. Desktop (1280x800) and phone (390x844) both returned: title, the two console errors and the warning, the CSP violation text, the uncaught error, the aborted stylesheet and CSP-blocked script as failed requests, the 404 response, the page text and its link, and a valid PNG (magic bytes 137,80,78,71; 8.3 KB desktop, 6.2 KB phone). The token never appeared in the formatted text.

## Nits left

- A token cut by the snapshot's 12,000-byte text cap or 120-character link-text cap before redaction could show a partial token. `buildSnapshot` caps first and A.12 doesn't edit `snapshot.ts`.
- Listeners keep pushing until `close()`, so a very late event can still change the returned arrays.
- The phone viewport is a desktop Chrome at 390x844, without `isMobile`, `hasTouch` or a device scale factor. The PRD asks only for the size.

## Beyond the scope

- A.6's adapter saves the screenshot, sets the thumbnail and calls `formatArtifactTestResult`. It builds `artifactTestBrowser(env.BROWSER)` in `compose.ts`.
- Add `CI=1` to the local dev notes if more tasks need Browser Run locally.

## Steps for Dom

None.
