# JB.4 browser verification

Verdict: PASS. All 8 flows work at desktop (1280x800) and phone (390x844). No app console errors and no unexpected failed requests. Two cosmetic observations are listed at the end (neither fails a flow).

Setup: worktree JB.4 at 7cb15cb4, `vite dev --port 3517`, browser session `jb4-verify`, dev login. The job draft was MOCKED: the local workspace has no Anthropic key, so after showing the no-key message I overrode `window.fetch` for `jobs.draft` to return `{cron:"0 9 * * 5", does:"Summarise support tickets for me", when:"Every Friday at 9:00", source:"routine", timezone:"UTC"}`. Everything else (create, pause, run now, timezone) hit the real local server and D1.

Local data note: the local DB already held a "Scout" agent, a leftover Scout job, and the workspace timezone Australia/Sydney from earlier runs. I created only "Ledger". I removed the leftover job through `routines.remove` so the empty state could be seen, and again between the desktop and phone passes. The timezone was returned to Australia/Sydney at the end.

Console and network (both sizes): the only errors were:
- 409 and 400 from my own setup calls (creating the duplicate "Scout", wrong `routines.remove` input). Not app defects.
- 400 on `jobs.draft` with no key (expected, the UI shows the message).
- 400 on `workspaces.setTimezone` for "Not/AZone" (expected, the UI shows the error).
- One 401 on Pause (desktop) caused by the stale Clerk session. After logging in again, Pause worked. Not an app defect.
- Dev-server log lines forwarded to the console: `PiRun: MCP server harbourmaster did not list its tools Network connection lost.` after pressing Run now. The local cloud runtime cannot start a real run here, so the job stays on "Last run running" (the sidebar also shows a "Failed" task). This is environmental, not part of JB.4.
- On phone I logged non-OK fetches in the page: only the 400 for Not/AZone. No page had horizontal overflow at 390px.
The Clerk development-keys warning is ignored throughout.

## 1. Agent room Jobs tab (desktop-1.png, phone-1.png)
Steps: open `/agents/<Scout id>?tab=jobs`. Saw: Jobs tab selected, heading "Jobs", "Describe a new job" textarea with placeholder "Every Friday, summarise support tickets for me.", disabled "Draft job" button, "No jobs yet. Describe one above." No Agent select. Pass on both sizes. On phone the tab row scrolls and "Settings" sits off-screen (normal).

## 2. Describe and draft (desktop-2a-nokey.png, phone-2a-nokey.png, desktop-2.png, phone-2.png)
No key: typed "Every Friday, summarise support tickets for me", pressed Draft job. Message: "This workspace has no Anthropic API key. Add one in Settings, Anthropic API key." (both sizes).
Mocked draft: "Review this job" card with the chips "Every Friday at 9:00" and "Summarise support tickets for me", the line "0 9 * * 5 (UTC)", and buttons Save job, Edit first, Discard. Discard removed the card (both sizes). Drafting again showed it again. Pass.

## 3. Edit first, then Save job (desktop-3a-dialog.png, phone-3a-dialog.png, desktop-3.png, phone-3.png)
Edit first opened the "Create routine" dialog with Name "Summarise support tickets for me", Schedule "Custom cron", cron "0 9 * * 5", Timezone "UTC", Prompt "Summarise support tickets for me". Closed it with Close, then Save job. The job row shows chips "Every Friday at 9:00 (UTC time)" and "Summarise support tickets for me", the line "Not run yet", and buttons Pause, Edit, Run now. Pass at both sizes.

## 4. Run now, Pause, Resume (desktop-4a-runnow.png, desktop-4.png, phone-4.png)
Run now changed the line to "Last run running, less than a minute ago" (the run cannot finish locally, see above). Pause showed a "Paused" chip and a Resume button. Resume returned the Pause button and removed the chip. Pass at both sizes. Note: the page header also has its own "Run now" (it opens a "start conversation" dialog for the agent); I used the one in the job row.

## 5. Edit on the routine job (desktop-5.png, phone-5.png)
Edit opened "Edit job - The routines of Scout. Pause, remove or create one here." with Create routine, and a table with the routine (Name, Schedule "every Friday at 09:00 UTC", "0 9 * * 5 UTC", Next task, Last fired "never", Status "active", Pause, Remove). Close worked. Pass at both sizes.

## 6. Workspace /jobs page (desktop-6.png, phone-6.png)
Lists the job with an agent chip (Scout). The describe box has an Agent select ("Choose an agent", Ledger, Scout) and Draft job stays disabled until an agent is chosen. Drafted for Ledger (mock), Save job: a second row appeared with the "Ledger" chip, "Not run yet". `/routines` and `/triggers` both ended at `/jobs` at both sizes. Pass.

## 7. Find (desktop-7.png, phone-7.png)
The unfiltered list has one option "Jobs Schedules and triggers" and no Routines or Triggers entry. Typing "jobs" gives exactly that one option. Typing "routine" gives no result. Typing "trigger" gives Jobs and Connectors. Pass.

## 8. Settings, Timezone (desktop-8a-saved.png, desktop-8.png, phone-8a-saved.png, phone-8.png)
`/settings/timezone` as admin shows the "Workspace timezone" field with the current value (Australia/Sydney), hint "Routines read their schedules in this zone unless a routine sets its own." Saved UTC, then Australia/Sydney: "Saved." each time, and the value survived a reload. "Not/AZone" gave the red text "Choose a valid timezone." (server 400). Pass at both sizes.

## Observations (no flow failed)
- Desktop only: in the Edit job dialog (flow 5) the routines table is 844px wide inside a 768px dialog, so the Remove button is clipped at the right edge (screenshot desktop-5.png). It may still be reachable by scrolling. It reuses the existing routines panel, so this may predate JB.4. Phone shows a stacked card layout and is fine.
- After Save job, the describe box keeps the old text ("Every Friday, summarise support tickets for me"), so the next Draft job needs it cleared by hand.
- `agent-browser snapshot -i` omitted the job-row buttons (they were visible and clickable via text locators), so I clicked them by text. This is a tooling quirk and I did not investigate it.
