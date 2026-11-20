# JB.5 browser walkthrough

Verdict: PASS. Every flow worked at 1280x800 and at 390x844, with no console errors and no failed requests apart from two that are explained below (one expected, one caused by the dev login setup). The two card states the fake runtime cannot produce (running, failed) were not exercised. One fact the reader should weigh: the agent card status line reads exactly the same before and after the run (see the card table).

## Setup

- Worktree JB.5, branch task/JB.5-jobs-e2e. Local D1 migrated with wrangler, dev server on port 3716 (started and stopped by this session), headless chromium via agent-browser, session jb5-verify.
- Signed in through /api/dev-login. Workspace "Dev Workspace". The fake-runtime agent "Fake echo" came from the seed script (id 01M7VH1X4ZVGDQ0FPJTKQ40WX4).
- Workspace timezone read at /settings/timezone: UTC.
- Real: the Jobs tab, the save, the run now, the fake runtime run, the Work tab, the agent card, the workspace /jobs page, pause and resume, and the database.
- Stubbed: only the job drafter. In the browser, window.fetch was overridden for requests containing "jobs.draft" and returned the proposed trigger (every Tuesday 09:00, cron 0 9 * * 2, timezone UTC, does "Summarise support tickets for the team"). The override was re-applied after each full page load. The draft counter showed 1 call per pass. The real drafter path was exercised once separately (below).
- Real drafter path, no stub: typed the description and pressed Draft job. The server answered with an error (status 400) and the page showed "This workspace has no Anthropic API key. Add one in Settings, Anthropic API key." as expected. Screenshot desktop-2a.png.
- Setup deviation for the phone pass: to start the phone pass with a clean empty state and so the card text could only come from the phone job, the desktop job was paused and then removed (Edit dialog, Remove, confirm) before phone flow 1. The desktop job's own results were already recorded. The phone pass then saved its own new job. The run count in the rail therefore includes both runs.

## Flow 1, Jobs tab, empty state

Desktop: /agents/<Fake echo>?tab=jobs shows the heading "Jobs", a "Describe a new job" box, a "Draft job" button (disabled while the box is empty) and the text "No jobs yet. Describe one above." Screenshot desktop-1.png.
Phone: same, after the removal described above. Same text, no horizontal overflow (scroll width 390, window width 390). Screenshot phone-1.png.

## Flow 2, describe and draft

Typed "Every Tuesday at 9, summarise support tickets for the team" and pressed Draft job (stubbed). A card appeared: "Review this job", chips "Every Tuesday at 09:00" and "Summarise support tickets for the team", the line "0 9 * * 2 (UTC)", and buttons Save job, Edit first, Discard. Same on both sizes, no overflow at 390. Screenshots desktop-2.png, phone-2.png. Real no-key message: desktop-2a.png.

## Flow 3, save

Pressed Save job. The review card went away and a job row appeared with the chips "Every Tuesday at 9:00" and "Summarise support tickets for the team", the line "Not run yet", and buttons Pause, Edit, Run now. Same on both sizes. Screenshots desktop-3.png, phone-3.png.

## Flow 4, agent card before the run

/home, card for "Fake echo": status line "Idle. Next run 24 Nov, 9:00 am". Also on the card: the title with a grey dot, "Echoes whatever it is told.", "Owner", "$0 this week". Rail: "0 done today" (desktop). Screenshots desktop-4.png, phone-4.png.

## Flow 5, run now

From the job row I pressed the "Run job now" button. The result line changed from "Not run yet" to "Last run ok, less than a minute ago". A toast said "Started. Its run shows under Work in the agent's room." The Work tab, after a reload, lists the task "Summarise support tickets for the team" with the output "Echo: Summarise support tickets for the team". The conversations page (/sessions) lists the same run as "Fake echo, Trigger, Done". Same on both sizes. Screenshots desktop-5.png, desktop-5a.png (Work tab), phone-5.png, phone-5a.png.

## Flow 6, agent card after the run

/home again, status line "Idle. Next run 24 Nov, 9:00 am". Compare with the table. The rail's "done today" counter went from 0 to 1 after the desktop run, and to 2 after the phone run (read on phone by opening the rail, screenshot phone-6a.png). The "$ this week" figure stayed "$0 this week" (the fake runtime has no cost). The dot next to the name stayed grey. Screenshots desktop-6.png, phone-6.png.
Not exercised: the "running" state (card shows the run title) and the "failed last run" state ("Failed"), because the fake runtime finishes inside dispatch and cannot fail.

## Flow 7, workspace /jobs page

/jobs shows the same job with the agent chip "Fake echo" beside the sentence chips, and the line "Last run ok, 1 minute ago" (desktop) and "Last run ok, less than a minute ago" (phone), with Pause, Edit, Run now. The page also has its own Describe box with an agent chooser. Screenshots desktop-7.png, phone-7.png.

## Flow 8, pause and resume

Pause job: the sentence gained a "Paused" chip, the button became "Resume", the result line stayed "Last run ok, ...". Resume job: the chip went away and the buttons returned to Pause, Edit, Run now. While paused, the agent card status line reads just "Idle" (no next run). After resume it reads "Idle. Next run 24 Nov, 9:00 am" again. Same on both sizes. Screenshots desktop-8.png (paused row), desktop-8a.png (card while paused), desktop-8b.png (resumed row), phone-8.png, phone-8a.png, phone-8b.png. phone-8c.png shows the Edit dialog (routines table) opened during the phone setup step.

## Card before and after

| Size | Before run | After run | Differs |
|---|---|---|---|
| Desktop 1280x800 | Idle. Next run 24 Nov, 9:00 am | Idle. Next run 24 Nov, 9:00 am | No |
| Phone 390x844 | Idle. Next run 24 Nov, 9:00 am | Idle. Next run 24 Nov, 9:00 am | No |
| Desktop, job paused | | Idle | |
| Phone, job paused | | Idle | |

Other things on the page that reflect the run: the rail counter "done today" (0 to 1 on desktop, 1 to 2 on phone; on phone the "before" value of 1 is carried over from the desktop run, it was not read again before the phone run). Nothing else on the card changed.

## Console and network

- Desktop, whole pass: two console errors, both status 400. One is the real drafter call with no key (expected, listed). The other, a 400 with an empty status text, appeared on the first page load after the dev login, before any job step. I reproduced it by clearing the console and signing in again at the start of the phone pass: it appears again right after /api/dev-login and nowhere else. Treated as a dev login (Clerk token redemption) artifact, not a job feature problem.
- Phone, whole pass: only that same dev login 400. No other errors.
- Ignored as instructed: the Clerk development-keys warning.
- Failed or non-2xx requests on the job pages: none seen. Checked by the console (the browser logs every 4xx and 5xx) and by the page's resource timing entries on the final pages (no entries with status 300 or higher or zero). The agent-browser "network requests" command returned nothing in this setup, so the per-request log was not available.
- Horizontal overflow at 390px: none on any page checked (agent Jobs tab, Work tab, /home, /jobs, rail open). Scroll width equalled window width (390) each time.

## Observations (do not fail a flow)

- After pressing Run now and switching to the Work tab inside the page, the tab first said "No tasks yet." although the run had completed (the rail already read "1 done today"). After a full reload the task was listed. The Work list looks not to refresh after a run started from the Jobs tab.
- The Edit dialog's routines table shows "Last fired: never" for the job even though the sentence says "Last run ok". A manual run does not count as fired there. Possibly intended, but the two can look contradictory.
- The card status line is identical before and after a successful run, and the dot stays grey. The only visible change on /home is the rail's "done today" counter, which on phone sits behind the rail button.
- On phone, the "Started" toast sits over the corner help icon at the bottom right, and the Draft job button shows in a muted brown when the box is empty (disabled). Neither blocked anything.
- The first dev server start was slow (a few minutes); not a product issue.

## Re-check after the fix (dispatcher, not the verifier)

The verifier's first observation, the Work tab saying "No tasks yet." after Run now, was fixed in `apps/web/src/components/jobs/jobs-panel.tsx` (`router.invalidate()` after a successful run now). The dispatcher re-checked it in the browser on a fresh dev server (port 3717, desktop size), signed in through the dev login, with the same local data. On the Jobs tab it pressed "Run job now", then opened the Work tab without a reload. The tab listed three "Echo: Summarise support tickets for the team" tasks where it listed two before. Screenshot: desktop-9.png. Not re-run at phone size.
