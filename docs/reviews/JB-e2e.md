# JB end-to-end walkthrough

Task JB.5. Verdict: the walkthrough passes on local at 1280x800 and 390x844. One defect was fixed on the branch. Two things need a decision and are proposed as tasks below.

The browser proof, step by step with screenshots, is `docs/reviews/tasks/JB.5/browser.md`. A fresh verifier ran it.

## What was real and what was not

- The run used the fake runtime. The agent was "Fake echo", seeded with `bun scripts/dev/seed-fake-agent.ts`. The fake runtime answers "Echo: <input>" and finishes inside dispatch.
- The drafter was stubbed in the browser. The local workspace has no Anthropic key, so the verifier overrode `window.fetch` for `jobs.draft` and returned a full proposed trigger (every Tuesday at 09:00, cron `0 9 * * 2`, the workspace timezone). Everything else was the real local server and D1: the Jobs tab, save, run now, pause and resume, the `/jobs` page and the agent card.
- The real drafter path was touched once without the stub. It answered 400 with "This workspace has no Anthropic API key. Add one in Settings, Anthropic API key.", and the page showed that text.
- The drafter has still never run against a live model. That is a step for Dom (below).

## Result by step

| Step | Result |
|---|---|
| Describe a weekly job | Draft card "Review this job" with the when chip, the does chip, the cron line, Save job, Edit first, Discard. |
| Save | The job shows as a sentence: "Every Tuesday at 9:00" and "Summarise support tickets for the team", "Not run yet", Pause, Edit, Run now. |
| Run now | The sentence changes to "Last run ok, less than a minute ago". The run is under Work with "Echo: Summarise support tickets for the team". |
| Card status line | "Idle. Next run 24 Nov, 9:00 am" before and after the run. While the job is paused it reads "Idle". |
| `/jobs` page | Same job with the agent chip and the same last-result line. |

The walkthrough ran at both sizes, each with its own saved job. No console errors and no failed requests apart from the expected no-key 400 and a 400 right after the dev login that is not part of Jobs.

Not exercised: the card's running state (shows the run title) and failed state (shows "Failed"). The fake runtime always finishes ok inside dispatch. `roster.test.ts` covers both.

## Fixed on this branch

- The agent room's Work tab said "No tasks yet." after Run now until a full reload, because the room reads route data and the Jobs panel only reloaded its own list. `jobs-panel.tsx` now calls `router.invalidate()` after a successful run now. Re-checked in the browser: the Work tab shows the new task straight away, without a reload.

## Proposed tasks

### JB.6 The card says how the last run went

Finding. After a successful run now, or any successful run, the card status line is the same as before ("Idle. Next run ..."), and the dot stays grey. The task asked to "see the result ... on the agent's card status line". RH.2 specifies the line as the waiting item's heading, the running task's title, "Idle. Next run <time>" or "Idle", so the card matches RH.2 and shows nothing about a finished run. The only trace on home is the rail counter "N done today", which on a phone sits behind the rail button. The card can say "Failed" or "Stopped part way" for a bad last run but has no wording for a good one. This is a wording and product decision, so it is not fixed here.

Scope. In `roster.ts` `activityFor`, when the last run finished ok and nothing is waiting or running, put the result in front of the next-run text, for example "Done: <run title>, 4 minutes ago. Next run 24 Nov, 9:00 am", and keep "Idle. Next run ..." once the last run is older than a day. Wording to be agreed with Dom first. Roster card test and `AgentCard` type unchanged apart from the text.

Check. `roster.test.ts` covers: last run done within a day, last run done over a day ago, last run failed (unchanged), a run waiting (unchanged). Browser with the fake runtime: press Run now, open home, read the new line.

### JB.7 A manual run counts as fired in the routines table

Finding. The Edit dialog's routines table (reused from `components/routines`) shows "Last fired: never" for a job that has just run, while the sentence says "Last run ok". `lastFiredAt` is written only by the cron tick. `jobs.runNow` leaves the trigger row alone on purpose: `jobs.test.ts` ("runNow starts one run per press and preserves the schedule") asserts the whole trigger row is unchanged. The two can look contradictory.

Scope. Decide the rule first: either `runNow` stamps `last_fired_at` (nothing schedules from that column, `next_run_at` stays untouched), or the routines table and the map inspector read the latest run for the routine. The first is a few lines in `jobs.ts` plus the changed test.

Check. `jobs.test.ts`: after `runNow`, `lastFiredAt` is set and `nextRunAt` and `disabledAt` are unchanged. Browser: run now, open Edit, the table shows a time, not "never".

## Nits left alone

- The describe box keeps its text after Save job, so the next draft starts with the old sentence. It was noted in JB.4 too. A fix needs the form to reset when a job is saved, which is a small change in `describe-job.tsx` and `jobs-panel.tsx`.
- The agent room has two "Run now" buttons: the header one opens a start-conversation dialog, the row one runs the job. They look alike.
- The rail's "N done today" does not refresh when a run ends on the same page. It updated on the next page load.
- Phone: the "Started" toast covers the help icon in the corner while it shows.

## Things to know about running this walkthrough

- A fresh local workspace cannot create an agent from the UI: Start blank shows "No runtime is available" and disables Create agent, because the fake runtime is not offered. Seed it with `bun scripts/dev/seed-fake-agent.ts` after the dev login.
- This host has no Playwright Chromium for agent-browser's default. Point `AGENT_BROWSER_EXECUTABLE_PATH` at the headless shell under `~/.cache/ms-playwright/chromium_headless_shell-1248/`.
- Right after `/api/dev-login` the first page load logs a 400 in the console. It is the Clerk token redemption, not Jobs.
- `agent-browser snapshot -i` often misses the job row buttons if the list has not loaded. They have aria-labels ("Run job now: ...") and `find role button --name` reaches them.

## Steps for Dom

- Try "Every Friday, summarise support tickets for me" on the Jobs tab with a live Anthropic key in Settings. Until then the drafter has only met a fake model and the browser stub.
- Decide JB.6 (card wording) and JB.7 (what counts as fired).
