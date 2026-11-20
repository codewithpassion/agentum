# SP.8 browser pass

Verdict: pass.

Setup: `vite dev --port 4317` in `apps/web` on a fresh local D1 (migrations applied), signed in through "Dev login (local only)". Seeded two agents through local D1, both owned by the dev user with a $1 weekly cap, `paused_reason = spend_cap`, and one finished run this week: "Over Cap Agent" at $1.05 and "Under Cap Agent" at $0.40. Both appeared as Paused at its weekly limit cards under Needs you. Browser: agent-browser, session "sp8-verify" (Playwright headless Chromium). Desktop is 1280x800, phone is 390x844. Remote D1 untouched.

## Flows

1. Over the cap, view (desktop-1.png, phone-1.png). Opened `/desk?item=<over agent>` via the Needs you link. Card reads "$1.05 of $1 this week". Only "Raise the limit" is present, and there is no Resume button. Pass at both sizes.
2. Under the cap, view (desktop-2.png, phone-2.png). Opened the under agent's card. Card reads "$0.40 of $1 this week". Both "Resume" and "Raise the limit" show. On the phone they sit side by side without wrapping or overflow (scrollWidth equals 390). Pass at both sizes.
3. Raise the limit on the over-cap agent (desktop-3/4.png, phone-3/4.png). Clicked "Raise the limit": the form opens with "New weekly limit in dollars" (prefilled 1) and "Raise and resume". Entered 2 and submitted. `spend.resume` was POSTed, the agent's `weekly_cap_cents` became 200 and `paused_at` became null in D1, the card cleared, and the rail moved to the other waiting card (the under-cap agent with Resume and Raise). Pass at both sizes. Screenshot 3 is the open form, screenshot 4 is the state after the raise.

I did not click Resume on the under-cap agent, as it was outside the request; the button is present and enabled.

## Console and network

No console errors or warnings other than the expected Vite debug lines, the React DevTools hint and Clerk's development-keys warning. No resource request had a status of 400 or higher (checked per page with the Performance resource timing list, since agent-browser does not report statuses). No errors in the dev server log. No failed requests, including the `spend.caps`, `spend.workspace`, `workspaces.timezone`, `spend.resume` and `desk.rail` tRPC calls.

## Notes

The earlier phone shots were taken with the data in the same state as the desktop ones. The desktop shots were retaken after a data reset at a true 1280x800. Scratch (seed SQL, dev log) is in `/home/roboto/devel/harbourmaster-wt/tmp/SP.8/`.
