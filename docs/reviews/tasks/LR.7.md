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

## Round 3

Date 2026-10-28. Main `a26240e5` (LR.9, LR.10, LR.11 merged). `staging:build` first: the built `dist/server/wrangler.json` named only Worker `harbourmaster-staging`, host `harbourmaster-staging.rockyshoreslabs.io`, D1 `harbourmaster-staging`, R2 `harbourmaster-staging-files`, queue `harbourmaster-staging-mail-events`. `staging:deploy` applied migration 0034 (`0034_heavy_randall.sql`, the only pending one) and uploaded version **20f9e1e4-6468-4584-9c0b-584b39e77d98**. No DO redeploy was needed. Production untouched, no Worker secret written. Two Clerk dev users signed in via `agent-login` (dev user and `hm-admin`). Six short paid runs in total (cloud isolate on the OpenRouter flash model, one Linux VM run on the same model, one managed run on haiku). The Anthropic key for the managed runtime went in through `managedKeys.set` (D1, encrypted), not a Worker secret. Logs in `harbourmaster-wt/tmp/LR.7/`.

| # | Item | Result | Evidence |
|---|---|---|---|
| 7 | Member exports through Browser Run (LR.9) | pass | Doc `.docx` (8.6 KB) and `.pdf` (19.5 KB), deck `.pptx` (44 KB) and `.pdf` (1 KB, one page). All answered 200 in 3.6 to 4.9 s, warnings `[]`. `file` reports Word 2007+, PDF 1.4 and a zip; `pdftotext` shows the document text. Files in `harbourmaster-wt/tmp/LR.7/exports/` for Dom's Office check (not a production blocker per Dom). |
| 3 | Document peer edit latency (LR.10) | fail (improved) | One character: 1.9 s to the peer (round 2: 2 to 3 s). Three characters typed in 0.2 s: first arrives after 6.4 s, all after 6.3 s to 15.6 s depending on the run (round 2: 20 s for five). The client no longer waits: peer frames reach the browser socket and apply on arrival. The wait moved to the server. The relay hands a peer one frame about every 0.9 to 1.0 s (browser WebSocket timestamps: sender at 0 s, peer frames at +1.8, +3.6, +5.5 s for three characters). Cause: `ArtifactRoom.webSocketMessage` runs inside `this.exclusive` and awaits `this.authorize(state)` for every inbound frame (`apps/web/src/server/live-artifacts/artifact-room.ts:1148`). In production that goes to `production-room.ts:280` and `resolveCredential` (`:64-84`), which re-runs `authenticateRoomRequest` (Clerk) plus a membership lookup per frame. `refreshSocket` (`artifact-room.ts:2034-2065`) also runs `authorize` and pushes a `{"type":"role"}` control to every socket about every 3 s, in the same queue. Fix: cache the authorize result per participant in the DO for a few seconds, and keep immediate revocation through the existing `accessFence` and `refresh(participantId)` paths. Spec asks 500 ms. |
| 3 | Deck peer latency (LR.12, known) | recorded | Add slide in one browser appears in the other after 2.3 s. Not failed. |
| 3 | 40px controls at 390x844 (LR.10) | pass for documents, fail for decks | Document page: 0 of 65 buttons, links and inputs under 40 px, no horizontal overflow (scrollWidth 375). Deck page: 41 of 77 controls are 33 to 35 px (Present, Add slide, Align, Undo, Layout and others). LR.10 left the deck unchanged on purpose. Suggested fix: a `min-height: 40px` rule for the toolbar buttons and selects in the `@media (max-width: 450px)` block of `apps/web/src/components/live-decks/deck-editor.css:361`, together with LR.12. |
| LR.11 | Connector auth choice on `https://gmailmcp.googleapis.com/mcp/v1` | pass | OAuth forced: the manual client dialog opened by itself, saved as "OAuth forced / needs auth" with the 23 Gmail tools listed, Connect redirected to `accounts.google.com` (it answered `invalid_client` for the fake client ID I typed, as expected). Automatic saved as "none / ok", None saved as "none forced / ok", same as before. Migration 0034 applied without error. |
| 2 | Selection trigger | pass | Selected "Suggested line", Ask agent. The thread envelope carried `via: ask_agent` and `where.selection`. The agent answered about the selected paragraph and did not edit. |
| 2 | Addressed-comment trigger | pass | Comment with "Address agent" produced an envelope `via: comment` with the thread id. The agent answered in the agent thread. The human comment thread stayed Open ("Addressed to agent"), nobody resolved it. Observation: the answer is not posted into the comment thread itself. |
| 2 | Linux VM runtime | pass | Cloud agent with environment `linux-vm`: `harbourmaster_document_read` returned the heading and `harbourmaster_bash` ran. Ask-before on `bash` paused the run ("Waiting for an answer", Call harbourmaster/bash); Allow once resumed it and the output `vm-ok` came back. (`uname -s` earlier answered "command not found" in the first run, odd for a Linux VM.) |
| 2 | Managed runtime | pass | Managed agent (haiku) called `document_read`; the run paused for approval, Allow once resumed it and it answered with the heading without editing. |
| 2 | Cloud isolate runtime | pass | Reads, edits, suggestions (round 2) and `artifact_create`/`artifact_test` (two pages) all worked. |
| 2 | Slack, machine runtimes | needs-Dom | Slack needs Dom's Slack app and workspace; machine needs a registered computer. Neither exists on staging. |
| 5 | 15-minute expiry and renewal (member) | pass | Member socket opened at 0, a `renewed` control with a new expiry 15 minutes ahead arrived at about 14 min, and the socket was still "Connected · owner" after 16.5 min with no reload. |
| 5 | 15-minute expiry (guest), guest arrival | needs-Dom | Needs a guest session, which needs the one-time code in Dom's inbox. |
| 5 | Concurrent D1 admission | fail (slow) | Eight simultaneous `liveArtifacts.join` calls all answered 200 in about 0.3 s. Eight simultaneous room sockets for one member: six admitted after 4.3 to 12.7 s, two had not received their first frame after 15 s. Admission queues behind the same per-frame `authorize` as above (about 1 s each). Same fix as the latency row. |
| 5 | Effect approvals | pass (members, managed and Linux VM) | Both runtimes paused on the approval, Allow once resumed them. Approval with a guest present and a real connector effect (Gmail) need a guest and a Google client: needs-Dom. |
| 6 | Network inspection | pass | Inserted `https://httpbin.org/redirect-to?...` (302 to a public PNG) through the toolbar. The editor shows `/files/<id>` (loaded, 100 px wide). The page's resource timings listed only the staging host and the Clerk dev host. httpbin was never requested by the browser. |
| 6 | Discovery beyond one page | pass | The agent created two page artifacts through `artifact_create` (both default to workspace audience). `liveArtifacts.embedSources` with limit 1 returned page one with `next` and page two without. The deck's "Embed page" select lists both. |
| 6 | Embeds (member) | pass | Choosing one added an iframe with `sandbox="allow-scripts allow-forms"` (no same-origin) pointing at `/a/<page id>`. |
| 6 | Guest embeds and revocation | needs-Dom | Needs a guest session. |
| 4d | Guest code, comment, revocation, `LIVE_GUESTS_OFF` | needs-Dom | Unchanged: Dom's inbox, and a var change plus deploy. |

Other observations. The agent-login cookie session expires in about an hour in headless tabs; tRPC then answers 401 until a new login. The room sends a `{"type":"role"}` control about every 3 s to every socket (noise and queue load, see above). Deck PDF export of the one-slide test deck is a single 1 KB page; look at it in a viewer.

Totals: pass 13, fail 3 (document peer latency, concurrent admission slowness, deck toolbar 33 px), recorded 1 (deck latency, LR.12), needs-Dom 5 rows (Slack and machine runtimes, guest expiry and arrival, guest embeds and revocation, 4d, with the guest-present connector effect inside the effect-approval row). Failures 1 and 2 share a cause.

## Left on staging (round 3)

Documents `LR7 doc A`, `LR7 doc B` (one imported image), `LR7 deck`, pages `LR7 P1` and `LR7 P2` (workspace audience), agents `LR7 cloud`, `LR7 vm`, `LR7 managed`, an OpenRouter key and an Anthropic key in the workspace (D1), three test connectors (`LR7 gmail oauth`, `LR7 gmail Automatic`, `LR7 gmail None`), one pending guest invite. Ask-before on `bash` for `LR7 vm` was switched back off.

## Round 4

Date 2026-10-29. Main `0fd6ef2b` (LR.12, LR.13, LR.14 merged). `staging:build` first: the built `dist/server/wrangler.json` named only Worker `harbourmaster-staging`, host `harbourmaster-staging.rockyshoreslabs.io`, D1 `harbourmaster-staging`, R2 `harbourmaster-staging-files`, queue `harbourmaster-staging-mail-events`. The first `staging:deploy` failed on the D1 migration call with Cloudflare error 7403 (transient, the same account listed migrations a minute later); the second deployed version **435d66e4-b003-4e0e-ba7a-f1dad77ea28c**. No migrations pending. Production untouched, no Worker secret written, no model call. Two agent-browser sessions (dev user and `hm-admin`; `hm-member2` for the role test). Logs and scripts in `harbourmaster-wt/tmp/LR.7/`.

Latency is measured browser to browser on one machine: a `beforeinput` timestamp in the typing page, a MutationObserver timestamp in the peer page, 5 samples each. Non-ASCII marker characters separate typed text from presence labels.

| # | Item | Result | Evidence |
|---|---|---|---|
| 3 | Document peer latency, 1 char | pass | 139, 349, 487, 689, 694 ms. Median 487, max 694 (round 3: 1.9 s). |
| 3 | Document peer latency, 3 quick chars | pass | Time until all three arrived: 351, 360, 383, 693, 702 ms. Median 383, max 702 (round 3: about 6 s). |
| 3 | Deck peer latency, 1 char | pass | 283, 416, 468, 482, 1352 ms. Median 468, max 1352. |
| 3 | Deck peer latency, 3 chars | pass | All arrived: 345 to 966 ms, median 457, max 966. |
| 3 | Same-cell typing in a deck table | pass | Both browsers typed three characters into cell 0:0 at once, 5 runs. 5 of 5: all 30 characters kept, both views identical after each run. |
| 5 | Eight concurrent room admissions | fail | Time to first frame, run 1: 2.5 to 12.6 s (0.3 s for the join call); run 2: 3.1 to 13.3 s. All got a frame, none within 3 s except the first one or two. One socket alone: 2.2 s; 2 sockets: 2.5 and 3.1 s; 4: 2.4 to 5.1 s. The fixed cost is the member check done twice, once in the Worker route (`routes.ts:46` then `live.admit`, `maintenance.start()`) and again in the Durable Object (`production-room.ts:396`, `artifact-room.ts:1105`). Each `authenticateRoomRequest` makes `authenticateRequest` (`auth.ts:98`), `sessions.getSession` (`auth.ts:105`) and `getOrganizationMembershipList` (`auth.ts:39`); a plain `GET /policy` (one check) takes 0.7 s. Suggested fix: pass the route's verified principal to the Durable Object (signed internal header or the stored credential) so the DO does not re-run Clerk, and cache the session and membership result for a few seconds per session id. LR.14 removed the queue serialisation but not this cost. |
| 3 | Controls at 390x844, document | pass | 0 of 69 under 40 px, scrollWidth 375. |
| 3 | Controls at 390x844, deck | fail | 24 of 56 are 33 to 35 px: All slides, Present, Version history, Hide pointers, member chip (`deck-editor.tsx:252-272`), Move slide earlier/later (`:652`, `:660`), Comment/Ask about selection, Background, Transition, Duration, Layout, Direction, Grid columns, Gap, Padding, Add token buttons (`inspector.tsx:112` and below). LR.12's rule (`deck-editor.css:361-386`) covers only `.ld-toolbar`. Suggested fix: use `.ld-editor button, .ld-editor select, .ld-editor input { min-height: 40px }` in that media block. |
| 5 | Revocation closes the room | fail (limit 1 s) | Removing `hm-admin` from the Clerk org: the socket closed 1.75, 1.18, 1.58 and 1.93 s after the Clerk API call returned. The room finds out by polling: alarm every 2 s (`artifact-room.ts:1040`) and a grant valid for 2 s (`:58`); LR.14's own note says 2 s plus lookup.. Suggested fix: a Clerk webhook (or the membership change path) that calls the room's `disconnect(participantId)`, or a 500 ms check interval. |
| 5 | Role downgrade to viewer | pass | `hm-member2` as editor on `LR7 doc C` typed into the room and the owner saw it. After `liveGuests.changeRole` to viewer the member socket closed within the call ("Document permissions changed. Reconnect to refresh access."), reconnect shows "Connected · viewer" with a non-editable editor, and typing attempted as viewer never reached the owner. |
| 7 | Exports | pass | Document docx 8.7 KB (3.8 s) and pdf 27 KB (6.3 s); deck pptx 62 KB (3.8 s) and pdf 3 pages (4.8 s); all 200, files in `harbourmaster-wt/tmp/LR.7/exports/r4-*`. Deck warnings are informational (embed placeholder, text layout). |
| LR.11/13 | Forced-OAuth connector | pass | A new connector on the Gmail URL with auth OAuth opened the "OAuth client for ..." dialog by itself (shared Google client unset). The old round-3 connector with a fake client id still redirects to Google and gets `invalid_client`, as expected. |

Product bug seen on the way (not in the thresholds): a member given a grant on a private artifact through `liveGuests.invite` (principalKind user) gets "This artifact is not available." on the page, although `liveArtifacts.join` and `open` answer with role editor. The route loader uses `artifacts.get` (`routes/a.$artifactId.tsx:53`), which does not look at `artifact_members`. The test used audience `workspace` as a workaround. Also: an idle second tab lost its room with `UNAUTHORIZED` after a few minutes (cookie session expiry in a background tab, as in round 2); Reconnect or a reload recovers.

Totals: pass 9 rows (4 latency rows, same-cell, document controls, role downgrade, exports, connector), fail 3 (admissions, deck controls, revocation timing). Needs-Dom items are unchanged from round 3 (Slack and machine runtimes, guest items, Gmail OAuth login).

## Left on staging (round 4)

`LR7 doc C` (workspace audience, `hm-member2` grant now viewer), connector `LR7 r4 gmail oauth`, plus the round 3 items. `hm-admin` is back in the Clerk dev org as org:admin after the revocation runs. Test text was added to `LR7 doc A` and `LR7 deck`.
