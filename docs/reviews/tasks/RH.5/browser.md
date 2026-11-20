# RH.5 browser verification (round 3)

**Verdict: PASS.** Every flow worked at desktop (1280x800 with the sidebar open, plus 1280 collapsed, 1600 and 1920 for layout) and at phone size (390x844). No console error and no failed request came from the change. Every error the browser or server logged traces to my own test data (rows written straight into the local D1 while the dev server was running, one malformed artifact id, a queued run nothing would ever claim) or to the missing machine daemon. Each is listed under "Console and network" below.

Build: worktree `/home/roboto/devel/harbourmaster-wt/RH.5`, head 34d01f51. `vite dev` on port 5193, fake runtime, a clean local D1 (I moved the old `.wrangler` to `tmp/RH.5/verify3/wrangler-prev` first, so no earlier round's data was used). Browser: agent-browser with chrome-headless-shell 1248, session `rh5-verify3`. I signed in with the "Dev login (local only)" link on `/login`, then ran `bun scripts/dev/seed-fake-agent.ts`, which created agent "Fake echo" `01M7VWPKVKZ24P0N207SPT54NB`. Test data went in through a throw-away script (`tmp/RH.5/verify3/rig.ts`, adapted from round 2).

## Screenshots

| File | Flow | What it shows |
|---|---|---|
| desktop-1 | a | Chat, idle, 1280 open: "Right now / Nothing is running." above the list and thread |
| desktop-2 | a | Work, idle, 1280 open: panel beside Recent tasks |
| phone-1 | a | Work, idle, phone |
| phone-2 | a | Chat, idle, phone: panel first, then the list, then the thread |
| desktop-3 | b | A task sent from the room composer, echoed back; the panel returns to idle |
| desktop-4 | b | Running run inserted: title, step "Web search", Open task, two helper chips |
| desktop-5 | b | Step line after more events ("Read file") |
| desktop-6 | b | Open task landed on the task (the `/tasks/<runId>` route redirects to `/threads/<sessionId>`) |
| desktop-7 | b, f | Full page at 1280 open with a computer: Right now, Screen, Helpers, then list + thread (thread 576 px) |
| desktop-8 | f | 1280 with the sidebar collapsed: thread left (816 px), panel and list stacked in the 320 px right column |
| desktop-9 | f | 1600 with the sidebar open: same right-column layout, thread 816 px |
| desktop-10 | f | 1920 with the sidebar open: same, thread 816 px |
| desktop-11 | c | After Stop on Helper alpha: only Helper beta is left; the parent still runs |
| phone-3 | b, c, f | Phone, full page: step "Web fetch", helpers beta and gamma, long-title thread header |
| phone-4 | c | Phone, after Stop on Helper gamma: only beta is left |
| desktop-12 | d | Watch opens the viewer: "Computer offline" (no daemon) |
| desktop-13 | d | After a takeover request: Take over enabled, "Fake echo is waiting for you." |
| desktop-14 | d | Take over clicked: 409 toast "The computer has no desktop running" |
| phone-5 | d | Phone, same 409 toast from the panel's Take over |
| phone-6 | d | Phone, Watch: request text and the "Computer offline" viewer |
| phone-7 | d | Phone, no computer: no Screen card |
| desktop-15 | d | Desktop, no computer: no Screen card |
| desktop-16 | e | Made today: tides.md (1.2 KB) and the "Tide chart" artifact (v1, Workspace) |
| desktop-17 | e | Learned this week: "Remembered: Dom prefers tide tables in metres, today" with Undo |
| desktop-18 | e, g | Work, 1280: full panel beside Recent tasks while the run waits on the takeover request |
| phone-8 | e | Phone, Chat: Made today and Learned this week |
| phone-9 | e | Phone, Work, full page |
| desktop-19 | g | Queued task behind the running one: the panel still shows "Research the harbour tides", step "Bash", Helper beta |
| phone-10 | g | Same at phone size |
| desktop-20 | f | New conversation dialog opened from the list in the right column (1600) |
| desktop-21 | h | Archived, Chat, 1280: no panel; list 320 px + thread 576 px; no empty column |
| desktop-22 | h | Archived, Work, 1280: Recent tasks fills the width (912 px) |
| phone-11 | h | Archived, Work, phone |
| phone-12 | h | Archived, Chat, phone |

## a. Panel present, idle state

Steps: I opened `/agents/<id>?tab=chat` and `?tab=work` on the fresh database before any run existed.

- Desktop 1280 open: on Chat, the panel (`data-testid=now-panel`) is a full-width row (912 px) above the list and thread and reads "Right now / Nothing is running." On Work, the panel is a 288 px column beside Recent tasks. No horizontal scroll (scrollWidth 1280). Evidence: desktop-1, desktop-2.
- Phone 390: on both tabs the panel comes first at 358 px, above everything else. scrollWidth 390. Evidence: phone-1, phone-2.

With no data, Screen, Helpers, Made today and Learned this week render nothing.

## b. Start a task, step line, Open task

Steps:
1. I typed "hello from verifier three" in the room composer and sent it. The fake runtime echoed "Echo: hello from verifier three" in the room thread, the conversation list updated, and the panel went back to "Nothing is running." No failed requests. Evidence: desktop-3.
2. I inserted a running run "Research the harbour tides" with two running child runs (`parent_run_id` set, `subagent_level` 1). Within about 3 s the panel showed the title, the step "From UI: Research the harbour tides" and Open task.
3. I inserted events one at a time and timed how long the step line took to change (script `steptime.sh`, polling the DOM every 250 ms):
   - `tool.call` web_search: "Web search" after 1.4 s
   - `tool.result`: "Web search: Found 3 tide tables" after 1.4 s
   - `tool.call` read_file: "Read file" after 3.0 s
   - `tool.call` bash: "Bash" after 2.2 s
   - at phone size, `tool.call` web_fetch: "Web fetch" after 1.8 s

   Every change landed inside one 3 s poll. Evidence: desktop-4, desktop-5, phone-3.
4. Open task has `href=/tasks/01M7VWS2ND00003DZ39433HB3J`, the running run's id. Clicking it landed on the task page ("Quarterly harbour operations planning and tide forecasting review", Running, Stop, Subagents). The existing `/tasks/$runId` route redirects to `/threads/<sessionId>`, which is behaviour from before this change. I checked the same at phone size. Evidence: desktop-6.

The task title comes from the run's input text ("Research the harbour tides"), not the conversation title.

## c. Helpers

Steps and results:
- Desktop: two chips, "Helper alpha: read tide tables" and "Helper beta: draft summary", each tagged "fake" and each with a Stop button whose aria-label names the helper. The chip links go to `/tasks/<childRunId>` for each child run. I clicked "Stop Helper alpha". `runs.cancel` returned 200 and alpha left the panel within about 4 s while beta stayed. In the database alpha is `cancelled`, beta is `running`, and the parent is still `running`. Evidence: desktop-11.
- Phone: I added "Helper gamma: check moon phase" and stopped it. `runs.cancel` returned 200, gamma left the panel and beta stayed. The parent is still running. Evidence: phone-3, phone-4.
- Phone: clicking the beta chip went to beta's own sub-conversation (`/threads/01M7VWS2RA…`, through the `/tasks` redirect).
- The parent itself never appears as a helper. A 288 or 320 px column truncates a long helper name with an ellipsis ("Helper alpha: read tide tabl…"), and the Stop button stays inside the card.

## d. Screen card

With a machine attached (`agents.computer_machine_id` set):
- Desktop and phone both show a Screen card with Watch and Take over. Take over is disabled, with the note "Fake echo has not asked for you."
- Watch opens the viewer in the card, which shows "Nobody is in control" and "Computer offline" because no daemon is running. "Stop watching" closes it. Evidence: desktop-12, phone-6.
- I opened a takeover request on the running run through the requests service. Within one poll, Take over became enabled, the note read "Fake echo is waiting for you." and the step line read "Approval required". Evidence: desktop-13.
- Clicking Take over at both sizes sent `takeover.take`, which returned 409, and a toast read "The computer has no desktop running". That is the expected failure with no daemon. Evidence: desktop-14, phone-5.

Without a machine: there is no Screen card at either size, and the rest of the panel is unchanged. Evidence: desktop-15, phone-7.

What I could not do: actually watch or take over a live desktop, because no machine daemon runs locally. Watch, the request-gated enable, and the error path all behaved correctly.

## e. Made today and Learned this week

- Absent with no data: neither card appeared in any of the steps above until I added data.
- Made today: I inserted a library file `agents/fake-echo/tasks/<runId>/tides.md` (1234 bytes) and a published artifact "Tide chart" whose version names the run as author. After a reload, Made today showed "tides.md 1.2 KB", linking to `/library?dir=…&file=…`, and "Tide chart v1 Workspace", linking to `/a/<id>`. Evidence: desktop-16, phone-8.
- My first artifact row used a ULID as its id. `artifacts.list` then failed output validation (artifact ids must be UUIDs), and because that run's read failed, the panel dropped its file as well. After I replaced it with a UUID id, both items showed. The failure was caused by my bad row. Real artifacts always get UUIDs.
- Learned this week: on the Knows tab I added the note "Dom prefers tide tables in metres" (learn level "Tell me after"). The Knows tab and the panel then both showed "Remembered: Dom prefers tide tables in metres, today" with Undo. Evidence: desktop-17, desktop-18, phone-8, phone-9.
- Both cards also stay up when nothing is running. In the quiet check at the end, the panel read "Nothing is running." above Made today and Learned this week.

## f. Layout

Measured with the long thread title "Quarterly harbour operations planning and tide forecasting review" and a live run on an agent with a computer, so the header carried the Running badge, Computer and Stop plus the rename, pin and archive icons. To get the live run into the room's thread, I moved the inserted run into the agent's main conversation and gave that conversation the long title.

| Width | Layout | Panel | Conversation list | Thread | Title |
|---|---|---|---|---|---|
| 1280, sidebar open (content 912 px) | panel row above list + thread | 912 px wide, on top | 320 px, left | **576 px** | 184 px wide, 2 lines, ellipsis after "Quarterly harbour…" |
| 1280, sidebar collapsed (content 1152 px) | thread left, right column 320 px | 320 px, right top | 320 px, under the panel | **816 px** | 424 px, 2 lines, "…tide forecasting…" |
| 1600, sidebar open | same as above | 320 px | 320 px under the panel | **816 px** | 424 to 499 px, 2 lines |
| 1920, sidebar open | same (content capped at 72rem) | 320 px | 320 px under the panel | **816 px** | 424 px, 2 lines |
| 390 phone | stacked: panel, list, thread | 358 px | 358 px | 358 px | 2 lines, badges on their own row |

At every width:
- No horizontal page scroll (scrollWidth equals the viewport width).
- No overlapping header controls. I checked bounding boxes of the title, the icons, Computer, Stop and the task picker.
- No word in the title breaks in the middle. The longest word, "forecasting", is 145 px, and the narrowest title box is 184 px. The title is clamped to 2 lines with an ellipsis.
- The thread tabs (Conversation, Files, Log) are intact, in one row under the header.

Round-1 issue (1280 open thread squeezed to about 272 px): fixed. The thread is 576 px, the same width the pre-change layout gives (a 20rem list beside a flex-1 thread in 912 px). At this width the 184 px title shows only "Quarterly harbour…" next to the badges. That cramping is inherited, because the thread is no narrower than before. Evidence: desktop-7.

Round-3 issue (512 px thread on wide content): fixed. From 72rem of content the thread keeps 816 px, and the panel and list stack in the right column. Evidence: desktop-8, desktop-9, desktop-10.

Work tab: the panel sits beside Recent tasks from 48rem, with columns 608/288 at 1280 open and 848/288 at 1600 and 1920. On a phone it stacks with the panel first. No horizontal scroll.

The conversation list in the right column still works (1600, sidebar open):
- Clicking "Helper beta: draft summary" in the list opened `/threads/01M7VWS2RA…`, and Back returned to the room.
- "New conversation" opened the dialog (desktop-20). On the first attempt, Start conversation failed with 409 "Run cannot be claimed". `runs.ts` refuses to claim a run while an older run of the same agent is still queued, and my inserted "Queued follow-up" run was exactly that (see g). Once I cleared my inserted runs, Start conversation opened `/threads/01M7VX8KJN…` with "Echo: New thread from the right column". This is test data, not the change.
- At phone size, clicking that conversation in the stacked list opened it.

## g. Queued task behind the running one

I inserted a queued top-level run "Queued follow-up: tidy the notes", created after the running one, so it is the newest task. The panel kept showing "Research the harbour tides" with step "Bash" and Helper beta on Work at 1280 and at phone size. It did the same earlier while the running run was in `waiting` (takeover request), where the step read "Approval required". The queued task never replaced it. Evidence: desktop-19, phone-10, desktop-18.

## h. Archived agent

I archived Fake echo from Settings and checked Chat and Work at 1280, 1600 and 390:
- No panel on any tab or width, and no horizontal scroll.
- Chat keeps the old two-column grid: `320px 576px` at 1280 and `320px 816px` at 1600, with no reserved third column. The thread area reads "This agent is archived, so it takes no new messages."
- Work: Recent tasks takes the full width (912 px at 1280, 1152 px at 1600).
- Phone: a single 358 px column.

Evidence: desktop-21, desktop-22, phone-11, phone-12. I restored the agent with Restore; its status is `active` again.

## Console and network

Ignoring Clerk's development-keys warning and the app-wide favicon, the session logged the entries below. None comes from the change.

Caused by my test data:
- About 20 × HTTP 500 on `artifacts.list`, `tasks.files`, `tasks.get` and once `desk.rail`. The server log shows `SQLITE_BUSY` / "Failed to get session commit token" at the moments my script wrote to the local D1 file while workerd held it. Each one came right after a `rig.ts` write.
- 11 × HTTP 500 on `artifacts.list` with `ZodError: Invalid UUID` (`artifactId`), plus one from a direct fetch I made to diagnose it. Cause: my first artifact row had a ULID id. It stopped once I replaced the row.
- 1 × HTTP 409 on `runs.start` ("Run cannot be claimed"). Cause: my inserted queued run, which nothing claims, blocked newer runs of the agent (`packages/services/src/runs.ts` around line 1505). It also left one cancelled "New thread from the right column" conversation in the list.

Caused by the missing machine daemon:
- 2 × HTTP 409 on `takeover.take` ("The computer has no desktop running"), the expected toast.
- 13 warnings "WebSocket connection to `ws://localhost:5193/api/machines/<id>/desktop/stream` failed" while Watch was open.

Caused by the change: none. In a final quiet check I opened Chat and Work at 1280 and at 390 and let each poll for 10 s, with the Made today and Learned this week data present. That was 41 to 55 requests per page, none failed, and no console errors.
