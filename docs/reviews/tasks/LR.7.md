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
