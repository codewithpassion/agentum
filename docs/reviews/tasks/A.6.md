# A.6 review record

## Verdicts

Round 1 (eb9d3e65): must-fix, three items.
- A missing `ARTIFACT_VIEW_KEY` made a live link open answer 500 and wrote a view row before signing failed, which told a caller a live link from a dead one. `openLink` now refuses first, with the uniform 404 and no row, and `sign` throws a ServiceError when the key is empty.
- `update` and `restore` left `artifacts.thumbnailKey` pointing at an older version, so the card showed a thumbnail the route answered 404 for. Both clear it now. `artifact_test` sets it again.
- The R1.13 test asserted nothing, because the fake browser never reported a token. It now reports token-bearing URLs and expects them redacted.

Round 2 (c310a011, fix commit only): clean. No must-fix.

## Nits left

- Member `open` and `mintTestToken` write their view row before `sign`, so a deploy with no `ARTIFACT_VIEW_KEY` records "ok" views that never opened. Sign first, then write.
- `setThumbnail` can put an older version's thumbnail back on the card if an `update` commits between its read and its write. Add `eq(artifacts.currentVersionId, version.id)` to the update's WHERE.
- A missing server key throws `ServiceError("invalid")`, a 400, where a 5xx fits.
- `artifacts.versions` loads the files of every version. The A.8 refinement asked for the shown version only. Fine for 200-file artifacts and tens of versions, worth a `version` input later.
- `blobs.put` runs before `atomic` in `setThumbnail`, so a failed write leaves an orphan PNG.
- The screenshot name uses `Date.now()` and not the injected clock.
- `withinLimits` counts the IP budget even when the token budget already refused. One 30 per minute limit covers a whole /24 or /48. All PR previews share namespace 2003.
- The tick prune runs only when a tick lands on 03:17, so a missed tick skips the day (the other prune jobs behave the same).
- `files` on `artifactVersionSchema` is a protocol change outside A.1, added for the A.8 share dialog and download. It is optional.

## Beyond the scope

- Move the prune to "once per UTC day, whenever a tick runs after 03:17".
- A rate limit per share, not just per token hash and IP prefix, once links get public traffic.
- `artifacts.versions` could return files only for a requested version.

## Steps for Dom

- Set the secret `ARTIFACT_VIEW_KEY` (`openssl rand -base64 32`) on production and staging with `wrangler secret put ARTIFACT_VIEW_KEY` (and `--env staging`), and on the preview base config with `wrangler preview base-config secret put ARTIFACT_VIEW_KEY --env staging`. Without it no artifact opens.
- The rate limit binding `SHARE_OPEN_LIMIT` (30 per minute, namespaces 2001, 2002, 2003) needs no setup. `ARTIFACT_LINKS_OFF` is an empty var in wrangler.jsonc: set any value in an environment to turn every link open off there.
- Local dev: `ARTIFACT_VIEW_KEY` is in `apps/web/.env.example`. Copy it into `.env.local`. `artifact_test` needs `CI=1` on `vite dev`, and `PUBLIC_BASE_URL` in `.env.local` must match the dev port.

## Local smoke (done)

`vite dev` on port 3106 with `CI=1`: a run token from a seeded run created a dashboard through `/mcp` (all five tools listed), `artifact_test` loaded it in local Browser Run and read the page text from its `data.json`, the member viewer showed it framed with `sandbox="allow-scripts allow-forms"`, the content URL opened as a top-level page redirected to `/a/<id>`, the thumbnail and download routes answered 200 for the session, a link created in the share dialog opened in a fresh browser with the share frame, and an unknown token answered the uniform 404.
