# LR.7 - staging acceptance run

Date 2026-10-28. Branch `task/LR.7-staging-acceptance` from main `48d32be9`. Environment: Worker `harbourmaster-staging`, `https://harbourmaster-staging.rockyshoreslabs.io`, Clerk dev instance. Production was not touched (one read-only `d1 migrations list`, `secret list` and `deployments list` against prod).

## Deploy

`bun run staging:build` first. The built `dist/server/wrangler.json` named only Worker `harbourmaster-staging`, custom domain `harbourmaster-staging.rockyshoreslabs.io`, D1 `harbourmaster-staging`, R2 `harbourmaster-staging-files`, queue `harbourmaster-staging-mail-events`. Then `bun run staging:deploy`: no D1 migrations pending (34 applied), version id **abbe021b-5f00-4fb5-9dac-da181f6191c7**, includes LR.5. No Durable Object redeploy was needed.

## Identities (Clerk dev instance, org in `ALLOWED_ORG_IDS`)

Created `dominik.fretz+hm-member2@gmail.com` (org:member) and `dominik.fretz+hm-admin@gmail.com` (org:admin). The existing dev user `dev@rockyshoreslabs.io` is org admin. Guest identity `dominik.fretz+hm-guest1@gmail.com` was invited (no Clerk user needed). Two browser sessions signed in through `agent-login` (dev user and member2) and a third as the admin.

## Blocking failure: member live room and export auth throws

`apps/web/src/server/live-artifacts/auth.ts:53` (and `:30`) calls `createClerkClient({ secretKey })` without `publishableKey`, then `clerk.authenticateRequest(...)` at `:84`. The SDK throws "Publishable key is missing" (reproduced locally; passing the publishable key makes it return a normal signed-out result). The room route and export route both catch the throw and answer 403 / 500, so no member can open a live document or deck, and no export works. Evidence on staging: `GET /api/rooms/<id>?ticket=...` with a valid ticket (`liveArtifacts.join` 200) returns 403 in `wrangler tail`; the document page shows "Disconnected / UNAUTHORIZED"; `POST /api/live-artifacts/<id>/export/pdf` returns 500. Suggested fix: pass `publishableKey: env.CLERK_PUBLISHABLE_KEY` in both `createClerkClient` calls in `auth.ts` (check `guest-infra.ts:60`, `mention-infra.ts:51` and `server.ts:130` for the same pattern, though they only call backend APIs). Local tests missed it because fixtures replace `authenticate`. Everything below marked "blocked" depends on this.

## Other findings

- No UI creates a document. `/artifacts` has "Create deck" only; `createDocument` is reachable only through tRPC or MCP. Product gap for R1.1, not a regression.
- A member who did not create a document cannot open it (`liveArtifacts.join` returns not found for member2). Visibility is by design: creator or admin (`packages/services/src/artifacts/service.ts:271`). Two-member editing therefore needs an admin-created artifact or an artifact member grant.

## LR.4 needs-Dom items

| # | Item | Result | Evidence |
|---|---|---|---|
| 1d | Two members, owner/admin, guest identity, public-only egress | pass | Member2 and admin sign in on staging; admin `join` returns role owner; `importImage` refuses 127.0.0.1, http and a redirect to 169.254.169.254, fetches public HTTPS. |
| 2 | Real-model runs, three triggers, speaker/roster, Slack, simultaneous editing, tools and ask-before on every runtime | fail (blocked) | Room auth bug above; no model call was made, so no paid usage. Rerun after the fix. |
| 3 | Section 4 and 5 actions with two browsers at desktop and 390x844, presence, latency, restore, presentation, checkpoints | fail (blocked) | Room 403. Partial: `createDocument` accepts a 5 MB markdown body (200) and rejects 8.3 MB ("Checkpoint exceeds artifact file limits") and 8.4 MB (400, 8 MiB input cap). Checkpoint deadlines untested. |
| 4a-c | Scanner GET, code request, cross-origin refusal | pass | Re-checked on the new build: `GET /g/bogus` 200 shell with `Cache-Control: no-store`, `Referrer-Policy: no-referrer`; LR.4 results unchanged. |
| 4d | Invitation, one-time code and mention mail, role change, audit, cap, approvals, guest comment, revocation, `LIVE_GUESTS_OFF` timing | needs-Dom | `liveGuests.setEnabled` and `liveGuests.invite` succeeded (200, no sender error) for `dominik.fretz+hm-guest1@gmail.com`, role commenter, 2 days, cap 3, artifact "LR7 doc A" (`8b1179e8-9e69-479e-b0b9-ace27e8cbf39`). Dom: check that inbox for mail subject "An artifact was shared with you", open the link, request a code (subject "Your Harbourmaster sign-in code"). The rest needs the room fix and Dom's inbox. `LIVE_GUESTS_OFF` needs a var change and deploy, not done. |
| 5 | Hibernation, restart recovery, member access loss, 15-minute expiry, D1 admission, effect approvals | fail (blocked) | Cannot hold a room socket. |
| 6 | Public HTTPS images and redirects via LOADER, owned blobs, no third-party browser requests, discovery, guest embeds | pass (server part) / needs-Dom (browser part) | Public PNG and a 302 to a public PNG import to `/files/<id>`; private and http targets refused. Browser network inspection, discovery over one page and embeds are blocked by the room bug. |
| 7 | PDF, Word, PPTX via Browser Run; Office fidelity; element ask; suggestions with two users | fail (blocked) | Export route 500 from the same auth throw, so Browser Run was not reached. After the fix Dom opens the exported .docx, .pdf and .pptx from a downloaded copy in Word and PowerPoint. |

Totals: pass 3 (1d, 4a-c, 6 server part), fail 4 (2, 3, 5, 7, all one cause), needs-Dom 1 (4d), plus the browser half of 6.

## Left on staging

Documents `LR7 doc A` plus three large or small test documents created by the dev user, guest enabled flag on, one pending guest invitation. Clerk dev users above remain.

## Round 2

Date 2026-10-28. Main `ccc5db1c` (LR.8 and LR.6 merged). The built `dist/server/wrangler.json` named only Worker `harbourmaster-staging`, host `harbourmaster-staging.rockyshoreslabs.io`, D1 `harbourmaster-staging`, R2 `harbourmaster-staging-files`, queue `harbourmaster-staging-mail-events`. Production untouched. No D1 migrations pending. Final clean staging version id **4aa40d88-9632-4ccf-8b77-75a534236370** (deploys that day: `bf023b3d`, redeploy `60e12e63`, a diagnostic build `46fcf869` with one extra `console.error` in the export catch, then the clean redeploy; the diagnostic edit was reverted and is not committed). Two Clerk dev users signed in via `agent-login` (dev user and `hm-admin`, both owners of `LR7 doc A`). Logs in `harbourmaster-wt/tmp/LR.7/`.

Setup added on staging: workspace model key set through `modelKeys.set` (OpenRouter, D1 not a Worker secret) and agent `LR7 cloud` (cloud runtime, `openrouter:deepseek/deepseek-v4.1-flash-1017`). A deck `LR7 deck` (`719c73c5-7c65-4a1e-b48b-29bd092bf809`). Three short model runs in total.

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Room WebSocket for members (LR.8) | pass | Both browsers show "Connected · owner" and each other as participants; the 403 is gone. |
| 7 | Exports through Browser Run (docx, pdf, pptx) | fail | Every member export still answers 500 "Export failed" in about 0.5 s, so Browser Run is never reached. Cause found with a temporary log line: `TypeError: Cannot reconstruct a Request with a used body`. `authenticateRoomRequest` builds `new Request(request, { headers })` at `apps/web/src/server/live-artifacts/auth.ts:93`, which consumes the body of `c.req.raw`; the second call (revalidation) at `apps/web/src/server/live-exports/routes.ts:43` then throws. Fix: build the Clerk request without the body (`new Request(request.url, { method: request.method, headers })`) or pass `c.req.raw.clone()` to each call. Local tests missed it because fixtures replace `authenticate`. Office fidelity for Dom stays blocked. |
| 2 | Real-model run, member composer trigger | pass | Cloud agent read and edited `LR7 doc A` (tools `harbourmaster_document_read`, `_edit`), appended "Agent was here." at revision 35, visible to both browsers. The thread envelope carried the sender and the present roster (the roster dropped Admin HM after that browser left). |
| 2 | Agent suggestions (ask-before) with two users | pass | With suggestion mode on, the agent's edit stayed pending and the document did not change; Admin HM accepted it and the text appeared in both browsers. The first checkbox click did not persist, the `setSuggestionMode` call did (no failure reproduced after reload). |
| 2 | Selection and addressed-comment triggers, Slack, machine, managed and Linux VM runtimes | not run | Out of reach in this pass. |
| 3 | Two-browser editing | pass with latency failure | Typing converges in both directions and after reload. A single character takes about 2 to 3 s to reach the peer, five characters about 20 s. Presence labels appear. Likely cause: `room-provider.ts:339` awaits `refreshPolicy()` (an HTTP `GET /policy`, 0.7 to 2 s here) before applying every inbound frame, serially. Fix: cache the policy and refresh it on the existing 30 s timer or only when a blob URL is unknown. Spec asks 500 ms for carets and prompt peer edits. |
| 3 | 390x844 layout | partial | No horizontal overflow, editor and toolbar usable. 3 of 70 controls are 24 px high: the Artifacts link and both export buttons (R1.17 asks 40 px). |
| 3 | Deck room | pass (open only) | Deck opens for both users, "Add slide" adds a slide visible to the peer. Presenting, builds, pointers, restore and checkpoint deadlines not run. |
| 5 | Hibernation | pass | After 100 s idle, an edit still reached the peer (about 15 s with the latency above). |
| 5 | Restart recovery | pass | Document content survived four staging deploys, including DO code changes. |
| 5 | Member access loss | pass | Removing `hm-admin` from the org through the Clerk API closed that browser's socket 0.2 s after the API call returned ("Disconnected"). Membership was restored. |
| 5 | 15-minute expiry, D1 admission, effect approvals | not run | |
| 6 | Browser half (network inspection, discovery, embeds) | not run | |
| 4d | Guest code request, comment, revocation, `LIVE_GUESTS_OFF` | needs-Dom | Inbox receipt confirmed by Dom in round 1. The code mail and the rest need Dom's inbox; `LIVE_GUESTS_OFF` needs a var change and deploy. |

Other observations. A browser tab idle for a few minutes got `Document service failed (401)` on the policy fetch and an export `401 Member authentication required` (cookie session token expired in a throttled headless tab); "Reconnect" recovered. The agent thread and task page show the raw `harbourmaster_turn` JSON envelope as the user message text. The live document pages render with almost no CSS (toolbar and sidebar unstyled).

Totals: pass 8 (1, composer run, suggestions, hibernation, restart, access loss, deck open, edit convergence), fail 3 (7 exports, 3 latency, 3 control size), not run 6, needs-Dom 1 (4d) plus Office fidelity.

## Left on staging (round 2)

`LR7 doc A` has test text, `LR7 deck`, agent `LR7 cloud`, an OpenRouter workspace key, and the earlier guest invite. `hm-admin` was removed and re-added to the Clerk dev org.
