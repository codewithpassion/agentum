# LR.4 — staging deploy and acceptance run

Date 2026-10-28. Source: main `cddf3332`, branch `task/LR.4-staging-deploy`. Environment: Worker `harbourmaster-staging`, `https://harbourmaster-staging.rockyshoreslabs.io`. Production was not touched.

## Deploy

- Deployed with `bun run staging:deploy` from `apps/web`. Built first with `bun run staging:build`. The built `dist/server/wrangler.json` named Worker `harbourmaster-staging`, one custom domain `harbourmaster-staging.rockyshoreslabs.io`, D1 `harbourmaster-staging`, R2 `harbourmaster-staging-files`, `PUBLIC_BASE_URL` on the staging host.
- Version id: **33171fed-9f81-441c-b731-fbb9490f7557**, 100% of traffic.
- Remote staging D1 before: 25 migrations applied (last `0024_rare_jack_flag.sql`), consistent with the repo (34 files). Pending were 0025 to 0033.
- Applied by the script: `0025_melodic_maximus` through `0033_chief_magus`, including `0032_lovely_lake` (guest comment tables). After: 34 applied, `migrations list` reports none pending. Tables `guest_comment_runs` and `guest_comment_effects` exist.
- Durable Object migrations v1 to v9 (including `ArtifactRoom`, `LiveArtifactMaintenance`, `GuestRun`) shipped in the same upload.
- Not redeployed. No DO could be exercised past the auth wall (see the Clerk failure below), so there was no old-code behaviour to retry against.

## Smoke checks

- `GET /` returns 307 to the Clerk handshake for signed-out clients, 200 for plain curl. `GET /api/health` returns `{"status":"ok"}`.
- `GET /g/<token>` with `Accept: text/html` serves the guest shell referencing `guest-entry-BPgM1eFk.js`, a new-build asset. In a browser (agent-browser) it renders "This invite is not available." for an unknown token.
- `GET /api/rooms/<id>` without upgrade returns 426. With a websocket upgrade and no ticket it returns 403.
- `/mcp` returns 401 and `/api/live-artifacts/<id>/policy` returns 401 unsigned.

## Blocker found: staging Clerk keys do not match

A browser load of `/` ends at HTTP 500 after the Clerk handshake. `wrangler tail` shows `Clerk: Handshake token verification failed ... Unable to find a signing key in JWKS that matches the kid='ins_3Kk8...' (reason=jwk-kid-mismatch)`. The staging `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` secrets appear to belong to different Clerk instances (publishable key points at `faithful-falcon-1887.clerk.accounts.dev`). Secrets were not changed by this task, so this predates the deploy. No signed-in browser flow can run on staging until Dom fixes the pair. I could not read secret values and did not change any secret.

## L.A.md release checklist

Result keys: pass, fail, needs-Dom.

| # | Item | Result | Evidence |
|---|---|---|---|
| 1a | Bindings provisioned (D1, R2, room/GuestRun DOs, LOADER, EMAIL, Browser Run, rate limits) | pass | Deploy output lists DB, FILES, BROWSER, EMAIL, LOADER, EXPORT/SHARE/APP limits and all DO classes on `harbourmaster-staging`. |
| 1b | Applicable migrations | pass | 0025 to 0033 applied, none pending afterwards. |
| 1c | Real Clerk signing | fail | Handshake 500, `jwk-kid-mismatch` (above). |
| 1d | Two distinct members, owner/admin, guest identities, public-only egress verified | needs-Dom | Dom: fix the Clerk key pair, create two workspace members plus an admin in the staging Clerk instance, add them to `ALLOWED_ORG_IDS`. |
| 2 | Real-model runs: doc and deck creation, three member triggers, speaker/roster, Slack, simultaneous two browsers plus agent, tools and ask-before on cloud, VM, Managed, machine, guest runtime combinations | needs-Dom | Needs signed members and paid provider inference. Steps: sign in as member A and B, create a document and a deck, run the three triggers, edit from both browsers while an agent edits, approve an ask-before call on each runtime. |
| 3 | Every section 4 and 5 action with a second signed browser at desktop and 390x844; 40px controls; presence; caret latency; restore; presentation; latest checkpoint in cards, thumbnails, read, history, download, shares; 5 MB and 8 MB limits and deadlines | needs-Dom | Needs two signed sessions. Steps: use two browsers, walk the action list, resize to 390x844, upload a 5 MB and an 8 MB document. |
| 4a | Scanner GET sends nothing | pass | `GET /g/<token>` (JSON and HTML) is read-only, 404 `Guest access unavailable` for an unknown token, headers `Cache-Control: no-store`, `Referrer-Policy: no-referrer`. |
| 4b | Code request does not reveal membership | pass | `POST /api/guest/<token>/code` with same-origin header returns `{"accepted":true}` for an unknown invite and email; `verify` with a wrong code returns 404 unavailable. No mail delivery was asserted. |
| 4c | Cross-origin guest writes refused | pass | `POST /api/guest/<token>/code` without matching `Origin` returns 403. |
| 4d | Real invitation, one-time code and mention mail; directory resolution; expiry, attempts, rate limits; cookie isolation; role change; audit; daily cap; approvals; guest thread, selection, addressed comment; scoped-tool refusals; revocation, expiry, switch and `LIVE_GUESTS_OFF` within 5 s | needs-Dom | Needs a real member to invite a controlled address and a real inbox. Steps: invite a guest, read the mail, open the link, enter the code, comment with an agent address, revoke and time the socket close; set `LIVE_GUESTS_OFF` and repeat. |
| 5 | Idle hibernation with open sockets, constructor restart, recovery, approval continuation, last-leave timing, member access loss, 15-minute expiry and renewal, concurrent D1 admission, effect approvals | needs-Dom | Needs a signed open document. Steps: open a document, idle past hibernation, remove the member, keep the tab 15 minutes. |
| 6 | Public HTTPS images and redirects through LOADER, owned blobs, no third-party browser requests, discovery beyond one page, guest embeds and revocation, sandbox behaviour | needs-Dom | Needs signed members. Steps: insert an external image URL with a redirect, watch network requests, embed from a library with more than one page of items. |
| 7 | PDF, Word, PPTX through Browser Run and quotas; fidelity in Office; element ask with a real model; individual suggestions with two signed participants | needs-Dom | Needs signed members and Office. Steps: export each format from a document and a deck, open in Word and PowerPoint, send an element ask, review suggestions as two users. |

Totals: pass 5, fail 1, needs-Dom 7 (sub-items 1a to 7).
