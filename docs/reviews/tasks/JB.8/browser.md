# JB.8 browser verification

Verifier: independent, headless Chromium via agent-browser (session `jb8-verify`), vite dev on port 5817, local D1 only. Source files unchanged. Commit 5d2bc0c.

Verdict: PASS (see Notes for two non-blocking observations).

## Setup notes
- Signed in through `GET /api/dev-login` (the target of the "Dev login (local only)" link). On `/login` the link was not rendered in the headless session (the page showed the signed-in landing instead), so I opened the link's URL directly. Session then redeemed at `/dev-login` and landed on `/home`.
- Seeded fake agent `01M7VVF1KR4J2YF87AHF6WP9SV`, then four `triggers` rows per round via `wrangler d1 execute`: pending routine (3-line prompt, `LATER-LINE-ALPHA`/`LATER-LINE-BETA` on lines 2-3), pending routine to reject, pending `http` trigger, approved-but-paused routine. Pending rows have `approved_at NULL`, `disabled_at` set, `proposed_by_agent_id` and `proposed_by_run_id` set. Reseeded between flows and sizes.

## Flows

| Flow | Desktop 1280x800 | Phone 390x844 |
|---|---|---|
| F1 /jobs states | OK, desktop-1, desktop-2 | OK, phone-1, phone-2 |
| F2 approve routine | OK, desktop-3 | OK, phone-3 |
| F3 reject routine | OK, desktop-4 | OK, phone-4 |
| F4 approve http trigger | OK, desktop-5, desktop-6 | OK, phone-5, phone-6 |
| F5 desk "See changes" | OK, desktop-7, 8 (trigger), 9 (routine) | OK, phone-7, 8, 9, 10 |

### F1
Steps: open `/jobs`, read rows, click "See the full prompt" on the pending routine.
Saw: pending routines and the http trigger show an orange "Waiting for approval" chip, no "Paused" chip, only Approve and Reject buttons (no Pause/Resume/Run now/Edit). The two routines have a "See the full prompt" disclosure; opening it shows all three lines including `LATER-LINE-ALPHA` and `LATER-LINE-BETA` (the collapsed title shows only line 1). The http trigger has no prompt, so no disclosure (expected). The approved paused routine shows "Paused" with Resume, Edit, Run now.
Phone: same content, stacked chips wrap, page `scrollWidth` 390 = viewport (no horizontal overflow).

### F2
Approve on the pending routine: row loses the Waiting chip, shows no Paused chip, and offers Pause, Edit, Run now. DB after: `disabled_at NULL`, `next_run_at 2026-11-23T09:00:00.000Z` (next Monday 09:00 UTC, matches "Every Monday at 9:00"). Same on phone.

### F3
Reject on the second pending routine: the row disappeared and does not return after the list refreshes. Same on phone.

### F4
Approve on the pending http trigger: modal "Trigger approved - Copy this secret now. It is not shown again." with an `ag_trg_...` secret and a curl example. Clicked Done: modal closed, row is now an enabled job (Pause, Edit; no chip). The secret text is absent from the page after closing and after a reload. Same on phone (dialog fits, no overflow).

### F5
Desktop: the desk shows one proposal card with Approve / See changes / Reject. Clicking "See changes" for both a routine proposal and an http trigger proposal landed on `/jobs`. With `history.pushState/replaceState` instrumented, the only navigation was `pushState /jobs`; no `/routines` or `/triggers` navigation. Phone: the desk is a list; tapping the card opens `?item=<id>` with the same actions, then "See changes" goes to `/jobs` with only `/jobs` pushed. Network log shows only Vite lazy-module prefetches of `components/routines|triggers/*` source files, no document request or redirect for `/routines` or `/triggers`.

## Console and network
- Console: only `[vite]` debug lines, the React DevTools info line and the Clerk "development keys" warning. No errors, no page errors (`agent-browser errors` empty).
- Network: no resource with status >= 400 on the final page loads (checked through `performance` resource `responseStatus`); no failed tRPC calls seen during approve/reject. favicon.ico not considered.

## Notes (non-blocking)
1. The job row shows "Not run yet" for both pending and approved routines. The next run time is stored (`next_run_at`) after approval but the row does not display it. The task text says "enabled job with a next run"; the row has no next-run label, so I judged by the enabled state and the DB value.
2. Row action buttons are 28px tall on phone (same as desktop), small for touch but tappable and not overlapping.
3. Reproduction detail: the Dev login link did not render on `/login` in headless mode, so I used its href directly.

## Screenshots
- desktop-1: /jobs initial states. desktop-2: pending routine with full prompt opened. desktop-3: after approving routine. desktop-4: after rejecting. desktop-5: trigger secret dialog. desktop-6: after Done, trigger enabled. desktop-7: desk with trigger proposal. desktop-8: /jobs after "See changes" (trigger). desktop-9: desk with routine proposal.
- phone-1: /jobs initial (full page). phone-2: full prompt opened. phone-3: after approve. phone-4: after reject. phone-5: secret dialog. phone-6: after Done. phone-7: desk list. phone-8: desk list (same state after click attempt before opening the card). phone-9: card opened with See changes. phone-10: /jobs after "See changes".
