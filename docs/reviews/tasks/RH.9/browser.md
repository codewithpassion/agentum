# RH.9 browser verification

Head 1d86dbc0. Dev server `TZ=UTC bunx vite dev --port 3411` (server zone UTC on purpose). Browser: agent-browser session `rh9-verify`, chrome-headless-shell, launched with `TZ=Australia/Sydney`. In the page `Intl.DateTimeFormat().resolvedOptions().timeZone` said `Australia/Sydney` and `new Date().toString()` said `Sat Nov 21 2026 02:33:52 GMT+1100 (Australian Eastern Daylight Time)`. Real clocks during the run: Sydney 02:33 to 02:41 AM on Sat 21 Nov, UTC 15:33 to 15:41 on Fri 20 Nov. A UTC slip would print 3:xx PM, so the Sydney hour is unmistakable. Viewer locale is en-US, so the day reads "Nov 21, 2:36 AM" and not "21 Nov, 2:13 am" (the day order follows the browser locale; hour and zone are right).

## Verdict: PASS

Every flow at both sizes printed the Sydney hour. The chat time, the desk pane time and the roster card status line all showed the same Sydney hour (2:35 to 2:41 AM, the minute of the run they belong to). No console errors and no failed requests in any flow. Flow F was not exercised (the fake runtime cannot ask a question). Some data had to be seeded straight into the local SQLite database to reach surfaces the fake runtime never produces (see "Seeded data").

## Flows

| Flow | Size | Steps | What was seen | Screenshot | Result |
|---|---|---|---|---|---|
| A Chat | desktop | Agent room, New conversation, sent "Hello fake agent, first message" at 02:35:13 AEDT (15:35:13 UTC), then a second message for a second run | Message label "Dev User · 2:35 AM", run marker "Task 1 of 2 · 2:35 AM", "Task 2 of 2 · this task · 2:35 AM". Sydney hour 2, not UTC 3 PM | desktop-1.png, desktop-2.png | pass |
| A Chat | phone 390x844 | New conversation "Phone hello" at 02:40:48 AEDT, then "Phone second" | "Dev User · 2:40 AM", "Task 1 of 2 · 2:40 AM", "Task 2 of 2 · this task · 2:40 AM" | phone-1.png | pass |
| B Task page | desktop | Opened /threads/<sessionId> and /tasks/<runId> (it redirects to the thread). Read header, run picker, Log and Files tabs | Header "Started by Dev User · Test runner · 2:35 AM, took 1s". Picker "Task 1 · Done · 2:35 AM ..." and "Task 2 · Done · 2:35 AM ...". Log rows (seeded events at 21:13 UTC and 10:05 UTC) "8:13 AM" and "9:05 PM". Files row (seeded mtime 21:13 UTC) "42 B · 8:13 AM" | desktop-3.png (picker), desktop-4.png (log), desktop-5.png (/tasks redirect), desktop-8.png (files) | pass |
| B Task page | phone | Same thread on a fresh load, header short row, picker, Log, Files | Short row "Done Fake echo · 2:35 AM". Picker "Task 1 · Done · 2:40 AM Phone hello", "Task 2 · Done · 2:40 AM Phone second". Log "8:13 AM", "9:05 PM". Files "42 B · 8:13 AM" | phone-2.png (picker), phone-3.png (log), phone-4.png (files) | pass |
| C Desk pane | desktop | The fake runtime never makes a "needs you" card, so one run was set to failed in the local DB (a problem card, which has runId and "How it got here"). Opened /desk?item=<runId>, expanded "How it got here" | "Fake echo started this Nov 21, 2:36 AM." and "Now: Failed." The run was created at 02:36:58 AEDT, so 2:36 AM is the Sydney time. Same hour as the chat time, 2 AM | desktop-6.png | pass |
| C Desk pane | phone | Same URL on a fresh load, details opened | "Fake echo started this Nov 21, 2:36 AM." | phone-5.png | pass |
| D Roster card | desktop | /home after a fresh run finished (the failed run had to be superseded by a newer done run, since the status line reads "Failed" while the latest run is failed). Added a routine "Daily hello", cron `0 8 * * *`, zone UTC, via a DB insert (the job drafter needs an Anthropic key) | "Done 2:37 AM: Roster card message ... Next run 21 Nov, 8:00 am UTC". Done part in Sydney (2:37 AM, finished 02:37:45 AEDT), Next run in the workspace zone and named (UTC) | desktop-7.png | pass |
| D Roster card | phone | /home fresh load | "Done 2:40 AM: Phone second. Next run 21 Nov, 8:00 am UTC" | phone-6.png | pass |
| E Hydration | desktop | Hard reload of /home, /desk?item=<runId> (details opened), /threads/<id>, console cleared before each | Final text after settle: home "Done 2:37 AM ... Next run 21 Nov, 8:00 am UTC", desk "Nov 21, 2:36 AM", thread "2:35 AM" labels. No hydration warning, no error in the console | none (text read from the pages) | pass |
| E Hydration | phone | Hard reload of /home, /desk?item=<runId>, /threads/<id> | Same final text with the Sydney hour. No hydration warning, no console error | phone-5.png, phone-6.png | pass |
| F Settled request line | both | Not exercised. The fake runtime only echoes, it cannot ask a question or hand back control, so no request card settles. `taskSettlement` is covered by unit tests only | n/a | n/a | not exercised (allowed) |

## Console and network

Console: on every page read after a hard reload (home, desk, thread; desktop and phone) there was no error and no hydration warning. The only entries were the Vite debug lines, the React DevTools hint and the Clerk "development keys" warning (expected, dev instance).

Failed requests: the agent-browser network log carries no status codes, so each page was also checked with `performance.getEntriesByType("resource")` filtered to `responseStatus >= 400`. It returned an empty list on /home, /desk, /threads/<id> at both sizes. The dev server log showed no error either.

One 400 appeared in the console during the run. It came from my own probe: I typed a job description into the Jobs tab and clicked "Draft job", and the page showed "This workspace has no Anthropic API key". The tRPC call answered 400 (Bad Request). I reproduced it on its own (cleared the console, clicked Draft job, saw the 400 again). It is unrelated to RH.9 and is not in any of flows A to F.

Not seen: favicon.ico (out of scope).

## Seeded data

The fake runtime echoes text and nothing else, so these rows were written straight into the local D1 SQLite (test data, no product code touched):
- run 01M7WSN3J4SQ1YKVTP3N51YKJM set to status `failed` (so the desk gets a problem card with "How it got here");
- routine `rtn_RH9VERIFY0000000000000001` on the fake agent, cron `0 8 * * *`, zone UTC, next run 2026-11-21T08:00Z;
- two events on run 01M7WSJ6EE5EA7HVJ7N9JHJQ01: `message.reasoning` at 2026-11-20T21:13:00Z and `tool.call` at 2026-11-20T10:05:00Z (they printed 8:13 AM and 9:05 PM, the Sydney equivalents of 21:13 UTC and 10:05 UTC);
- a `library_entries` row `agents/fake-echo/tasks/01M7WSJ6EE5EA7HVJ7N9JHJQ01/notes.txt`, mtime 2026-11-20T21:13:00Z (printed 8:13 AM).

## Notes

- The seeded failure shows that a roster card whose latest run failed reads "Stopped ... Failed", so "Done <time>" needs a newer done run. That is existing behaviour, not a regression.
- `/tasks/<runId>` redirects to `/threads/<sessionId>` (as before), so there is no separate task page view to read.
- Screenshot numbering: desktop-1 first message, desktop-2 two runs, desktop-3 run picker, desktop-4 Log tab, desktop-5 /tasks redirect, desktop-6 desk "How it got here", desktop-7 roster card, desktop-8 Files tab; phone-1 chat, phone-2 picker, phone-3 Log, phone-4 Files, phone-5 desk, phone-6 roster card.
