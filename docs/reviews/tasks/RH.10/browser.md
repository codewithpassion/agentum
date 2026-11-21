# RH.10 browser verification

Build: branch task/RH.10-the-find-dialog-s-hidden-heading-is-on-e, `vite dev` on port 5191, signed in through `/api/dev-login`. Headless Chromium, agent-browser session `rh10-verify`. Checked the accessibility snapshot and `document.querySelectorAll('h1..h6,[role=heading]')` each time.

| # | Flow | Desktop 1280x800 | Phone 390x844 |
|---|------|------------------|---------------|
| 1 | Closed dialog, /home: no "Find" heading (a11y tree and DOM) | pass, desktop-1.png, headings were Home and four h2s | pass, phone-1.png |
| 1b | Closed dialog, second page (/spend desktop, /spend phone): no "Find" heading | pass, desktop-5.png | pass, phone-3.png |
| 2 | Open dialog: Ctrl+K opens, search input focused, tree shows `dialog "Find"` with the heading and the description "Find an agent, a team, a page or a setting" | pass, desktop-3.png | pass with Ctrl+K, phone-4.png. Also opened from the top-bar menu then "Find" button, input focused, phone-7.png |
| 3 | Type a term, results filter, Enter navigates, dialog closes | typed "Spend": list narrowed to Spend plus 2 settings, Enter went to /spend, dialog gone, desktop-4.png and desktop-5.png | typed "Files": list narrowed to Library, Enter went to /library, dialog gone, phone-5.png and phone-6.png |
| 3b | Reopen, Escape closes | pass (1 dialog, then 0), desktop-6.png | pass, phone-8.png |
| 4 | After closing: "Find" heading gone | pass, 0 matches in snapshot and DOM, desktop-6.png | pass, phone-8.png |

## Console and network

No errors from the Find dialog flows. One `Failed to load resource: 400` console error appeared only while `/api/dev-login` redeemed a sign-in token on a browser profile that already had a Clerk session (twice, both times). It did not appear on reloads or during the flows, and it did not appear when I cleared cookies and signed in fresh. I treat it as a Clerk sign-in artifact of re-running dev login on a signed-in session, not part of this change. The network request log shows no 4xx or 5xx during the flows (the per-navigation capture does not cover the dev-login redirect itself, so I could not name the failing URL). Clerk development-key warning and WebGL fallback warnings are noise.

## Verdict

PASS. Every flow works at both sizes. The 400 above is the one caveat: it comes from the dev-login setup on a reused session, with no repeat on a fresh sign-in.
