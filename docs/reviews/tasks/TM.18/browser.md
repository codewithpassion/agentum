# TM.18 browser check: Lead listens switch (second verifier, session tm18-verify2)

Dev server on port 3201 (`vite dev`, log `harbourmaster-wt/tmp/TM.18/dev2.log`), local D1 after `migrations apply`, team "Listen Team" reused. Fresh browser profile (empty cookie jar), dev login as the admin dev user. Sizes 1280x800 and 390x844. At each step I read the console, a `fetch` hook (status of every request the page made) and `PerformanceResourceTiming.responseStatus`. The agent-browser `network requests` command captured nothing in this build, so the extra evidence for the 400 came from a separate Playwright script (outside the worktree) that logs every response with status >= 400.

## Flow 1: layout (desktop-1.png, phone-1.png)
The Lead select, then the "Lead listens" switch (on), with the sentence "The lead hears room messages that name nobody, and hands the work out." wired as its description (`aria-describedby=team-lead-listens-help`). `scrollWidth` equals `clientWidth` at both sizes (1280/1280, 390/390). No alert. Pass at both sizes.

## Flow 2: persistence (desktop-2.png, phone-2.png, screenshot taken after the off reload)
At each size: toggle off, `aria-checked` false, tRPC `teams.update` 200, no alert. Reload, still off. Toggle on, reload, on. Local D1 `teams.lead_listens` read 1 for Listen Team at the end. No console error, no status >= 400 in the request hook or resource timing at any step. Pass at both sizes.

## The 400 from the earlier run
Evidence, in order:
1. Not reproduced. Six fresh sessions (one agent-browser, five Playwright, each with dev login, then home, /teams and the team page) produced no 400 at all. The only error was `GET /favicon.ico` 404 from localhost, on every page including /login before login, so it is app-wide and unrelated to this task (a console line that reads "404 (Not Found)", not 400).
2. The earlier line was `status of 400 ()` with empty status text. A 400 from our own server prints a status text: I forced a tRPC 400 (`teams.get` with a bad input) and the console read `status of 400 (Bad Request)`. Responses from localhost (HTTP/1.1) carry the text, so the earlier request was not to localhost, not one of ours (`/api/trpc/...`, team routes).
3. Third-party responses print in exactly that empty-text form. With a stale Clerk dev cookie (`__clerk_db_jwt`, `__client_uat`, `__session`) in a fresh context, Clerk's own API `https://faithful-falcon-1887.clerk.accounts.dev/v1/client` and `/v1/environment` answered 401 and the console printed `status of 401 ()`. The earlier verifier used the shared persistent agent-browser profile (2.3 GB, with "duplicate cookies" warnings for the Clerk cookies on localhost), which is where such Clerk dev handshake errors come from.
4. The same Clerk page also fires `client.protect.clerk.com/.../probe` requests that are aborted by the browser on every load, on /login and /home as well, so Clerk noise exists app-wide.
5. The dev log (`dev2.log`) holds no 400 and no error, and no switch or team route returned a status >= 400 in any run.

I did not capture the exact 400 URL. The conclusion is by exclusion and format: it was not from localhost, it did not recur on a clean profile on any page, and it matches Clerk dev-instance stale-cookie behaviour. It is not caused by this task's code.

## Earlier-run flows (copied from the earlier verifier, session tm18-verify, not redone here)
Setup then: one agent row (`Leader`, runtime `fake`) inserted with sqlite3, team "Listen Team" made through the UI with Leader as member and lead. Screenshots desktop-3.png, desktop-3b.png, phone-3.png, phone-3b.png, desktop-4.png, phone-4.png are from that run.

Flow 3, room wake (key check): topic "Test topic" in the team room with Leader ticked. Counts read from local D1.
- Desktop, switch off: posted a message naming nobody. Posts 0 to 1, events only `inbox.posted`, runs 0, sessions 0. The lead did not wake.
- Desktop, switch on: posted again. runs 1, sessions 1, events `run.queued, message.user, run.started, message.assistant, run.finished, inbox.posted`, reply shown in the thread. The lead woke.
- Phone, switch off (DB 0): posted, runs stayed 1, posts 3 to 4. No wake.
- Phone, switch on (DB 1): posted, runs 1 to 2 with the same event chain. Woke.
Pass at both sizes.

Flow 4, member does not see the switch: member Tester (not admin, not team owner) sees no Lead select, no "Lead listens" switch and no sentence at both sizes; no horizontal scroll at 390. Pass.

## Verdict
PASS, with a caveat: the single `400 ()` console line from the earlier run is a third-party (Clerk dev instance) response, not from this task's code, and not app-wide in the sense of recurring; the exact URL was not captured and the claim rests on the points above. Every flow works at both sizes, and nothing this task adds produced a console error or a failed request in this run (the only error anywhere is the app-wide `/favicon.ico` 404).
