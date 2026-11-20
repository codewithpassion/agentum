# SP.5 browser verification (round 2)

Verdict: PASS. Flows A to D work at 1280x800 and at 390x844. Every page figure equals the hand sum except the two known gaps (the $0.60 team dream and the rounded Fake echo "last week"). The only console errors and non-2xx responses are the known ones: the single `400` in the dev-login hop and the `409 Conflict` from Run now and from Dream now on a paused agent. Nothing else failed. Things that look odd or confusing are listed at the end.

## Setup

Branch `task/SP.5-spend-e2e`, head bdd2617e. Vite dev on port 3617 from `apps/web` after `wrangler d1 migrations apply DB --local` on an empty local database. agent-browser session `sp5-verify2`, headless Chromium (chrome-headless-shell 1248). Signed in once through `/api/dev-login`. Then `bun scripts/dev/seed-spend.ts`: agentA Fake echo `01M7WQER0BA8ECSVS0TJPZ8XY0`, agentB Fake second `01M7WQER1TEZ0S0756HE7XB7EZ`, mailbox `sp5-local-echo@agents.rockyshoreslabs.io`, workspace timezone Australia/Sydney. In the sandbox "now" was Sat 21 Nov 2026 about 02:00 Sydney, so "this week" starts Mon 16 Nov and "last week" starts Mon 9 Nov. No agent, mailbox or Clerk user was created. The mailbox was never touched from the UI. Mail went in only with curl to `/cdn-cgi/handler/email` (reply "Worker successfully processed email" every time). The database was read with `sqlite3 -readonly`. The dev server (the PID I started, its vite child and the workerd it spawned) was stopped at the end, and the browser was closed.

The desktop pass ran first, then the phone pass on the same data. Each pass ended with both agents resumed, Fake echo's own limit cleared and the workspace cap cleared (checked in the database: `paused_at` null, `weekly_cap_cents` null on both agents and on the workspace). The phone pass used different mail subjects and message ids (`Phone mail one` to `four`).

Hand sum (`handsum.sql`, run before the desktop pass and again after the phone pass, identical both times; the fake runs add nothing):

| Row | 19 Oct | 26 Oct | 2 Nov | 9 Nov (last week) | 16 Nov (this week) |
|---|---|---|---|---|---|
| Fake echo | 1.5 | 0.75 | 3.0 | 2.062 | 1.05 |
| Fake second | | | | 2.0 | 0.55 |
| (team dream) | | | | | 0.6 |

Dream cost check: all four `dream_runs.usage` rows satisfy `costUsd = inputTokens x 0.10/1e6 + outputTokens x 0.50/1e6` (0.2, 0.4, 0.1, 0.6).

## Flow A: totals against the hand sum

Desktop. `/spend` (desktop-1): bar labels `$1.50 $0.75 $3.00 $4.05 $1.60` for Oct 19, Oct 26, Nov 2, Last week, This week. Table: Fake echo `$1.50 $0.75 $3.00 $2.05 $1.05`, Fake second `$0 $0 $0 $2.00 $0.55`, Total `$1.50 $0.75 $3.00 $4.05 $1.60`, Limit `None` for both. Every cell matches the hand sum except the two known gaps: last week reads $2.05 for Fake echo against 2.062, and this week reads $1.60 against $2.20 with the team dream. Hover on the Last week bar shows the tooltip "Last week / $4.05" (desktop-2). Home (desktop-3): both cards read `$0 this week` (known gap). No spend pill in the header without a limit.

Phone. `/spend` (phone-1, full page phone-2): same bars, labels and cells. The table is 471px wide inside a 358px box. It scrolls sideways inside its own container (phone-4 shows it scrolled to This week and Limit), and the page itself does not (document scrollWidth 390). Hover tooltip on the Last week bar (phone-3; this headless context has no touch, so I used mouse hover). Home (phone-5): both cards `$0 this week`.

## Flow B: pause and resume from the UI

Desktop. Fake echo, Settings tab, Weekly limit 1, Save shows "Saved." (desktop-4), database `weekly_cap_cents` 100. Run now with "desktop run one, over the cap" (desktop-5): the run ends Done and in the same second the agent is paused, reason `spend_cap`. Home card "Paused. Weekly limit reached", "$1.05 of $1 this week", red state, "Needs you 1" and the chip "Paused at its weekly limit" (desktop-6). Agent header: pill "$1.05 of $1 this week" and a red "Paused. Weekly limit reached" pill (desktop-7). `/spend`: the Fake echo row has a "Paused" tag and Limit `$1` (desktop-8). The Needs you drawer lists "Paused at its weekly limit, Fake echo stopped at its weekly limit" (desktop-9). The item opens at `/desk?item=<agentA id>` with "The limit is $1 a week.", Resume and Raise the limit (desktop-10).
- Run now on the paused agent: the dialog stays open and shows "Fake echo is paused. Its weekly limit was reached." (desktop-11). No run was created. Console: one 409.
- Knows tab, Dream now: "Fake echo is paused, so it does not dream" (desktop-12). Console: one 409 (`dream.runNow`).
- Resume: item and chip gone, "Nothing needs you", agent `paused_at` null, limit stays $1 (desktop-13).
- Run now again: run Done, agent paused again (known behaviour).
- Raise the limit: one input "New weekly limit in dollars". Empty then submit: "Enter the new limit in dollars." (desktop-14). "abc": "Enter a dollar amount above zero, like 20 or 12.50." (desktop-15). Neither changed the agent. 20: agent resumed, `weekly_cap_cents` 2000 (desktop-16).
- Run once more: run Done, agent not paused. Settings shows Weekly limit 20 (desktop-17).

Phone. Same sequence, same results and same texts. Limit 1 saved (phone-6, phone-7). Run now, run Done, agent paused. Home card with the chip (phone-8), agent header with the pill and the red Paused pill (phone-9), `/spend` row tagged Paused with Limit `$1` (phone-10), Needs you drawer (phone-11), item card with Resume and Raise the limit (phone-12). Run now on the paused agent shows the refusal (phone-13). Dream now shows "Fake echo is paused, so it does not dream" (phone-14). Resume clears the pause (phone-15). Run now again: Done, paused again. Raise the limit: empty (phone-16), "abc" (phone-17), 20 resumes. Next run is not paused. Settings shows 20 (phone-18).

## Flow C: pause and resume from mail

Desktop. Fake echo limit set to 1 (Saved.). Mail 1 "Desktop mail one" (new thread): a run with request_id `mail:b445b59c-...` ended done, and the agent was paused 1 second later (reason `spend_cap`). Mail 2 "Desktop mail two" (new subject): run count unchanged (21), and the thread holds the received mail plus an outbound reply "Re: Desktop mail two" reading "Fake echo is paused. Its weekly limit was reached." (status sent). Mail sheet at `/agents/<agentA>?mail=1` (desktop-18) lists both threads. The thread view shows Received then Sent (desktop-19). Mail 3 "Re: Desktop mail two" with In-Reply-To and References to mail 2: no new run, no second reply. The thread now reads in, out, in (desktop-20). Raise the limit on the Needs you card to 20: agent resumed. Mail 4 "Desktop mail four" (new thread): a run `mail:b992047b-...` ended done and the agent was not paused. Final mail list (desktop-21).

Phone. Same with `Phone mail one` to `four`. Mail 1 run `mail:ff72ca7f-...` done, agent paused. Mail 2: reply sent, no run. Mail 3 (reply in thread two): no reply, no run, run count unchanged (28). Mail list (phone-19) and the thread with Received, Sent, Received (phone-20). Raise to 20 on the card, mail 4 run `mail:56e92727-...` done, agent not paused. Mail list at the end (phone-21).

## Flow D: workspace cap

Desktop. `/settings/spend` (desktop-22), workspace limit 2, Save shows "Saved." (database 200). Run a task on Fake second (the dialog opened with Fake second selected): run Done, neither agent paused (known gap, the page total is $1.60 without the team dream). Limit 1.5, Saved. (desktop-23, database 150), run on Fake second: run Done, both agents paused in the same second, both `spend_cap`. Home: both cards "Paused. Weekly limit reached", Needs you 2, two chips (desktop-24). Fake echo's card (desktop-25): "The workspace limit of $1.50 a week is reached. Raising this agent's limit will not restart it." with Resume and "Raise the workspace limit". `/spend` (desktop-26): "Workspace: $1.60 of $1.50 this week.", a dashed line labelled "Workspace limit $1.50", both rows tagged Paused, Fake echo limit `$20`, Fake second `None`. Then: workspace limit cleared (empty, Saved.), Resume on both cards, Fake echo's own limit cleared (Saved.). End state: no pause, no limits (desktop-27).

Phone. Same results. Limit 2 (phone-22), run on Fake second, not paused. Limit 1.5, run on Fake second, both paused. Home (phone-23), Fake echo card with the workspace-limit text (phone-24), `/spend` with the dashed line, "Workspace: $1.60 of $1.50 this week." and both Paused tags (phone-25). Cleared and resumed, end state checked in the database and on `/spend` (phone-26).

## Console and network

After each flow at each size I read the console, the page errors and the Resource Timing entries with status 400 or above.

| Page | Error | Verdict |
|---|---|---|
| `/dev-login` hop (first load after sign-in) | `Failed to load resource ... 400` | Known, once |
| Agent page, Run now on a paused agent (desktop and phone) | `409 (Conflict)` | Known, designed refusal |
| Agent page Knows tab, Dream now on a paused agent (desktop and phone) | `409 (Conflict)` on `/api/trpc/dream.runNow` | Known, designed refusal |

No page errors. No failed resource in any other flow. No favicon 404 showed in the log.

## Observations (not failures)

- The Home card says `$0 this week` for Fake second while `/spend` says $0.55, and `$0 this week` for both agents with no limit. With a limit set the card shows `$1.05 of $1 this week` like `/spend`. Known gap.
- The seeded team dream ($0.60) is not in the page total or in the workspace cap. With the cap at 2 nothing paused although the data says $2.20. Known gap.
- Fake echo "last week" shows $2.05 against 2.062 in the hand sum (per agent-day rounding). Known gap.
- Resume without raising the limit gives one more run, then the pause lands again. The card does not say so.
- The workspace-cap card offers Resume, which on its own would pause the agent again on the next run end. The card says raising the agent's limit will not help but does not say what Resume does.
- A paused card for Fake second, opened after the workspace cap had already been cleared, shows only the title, the name and two buttons, with no sentence about why it paused.
- The dashed "Workspace limit" label sits on the This week bar and its value label. It is clearly in the way at phone width (phone-25). On desktop the hover tooltip covers the value label of the bar (desktop-2).
- The mail list says "1 messages" for a one-message thread. A thread with an outbound reply shows the chips "Sent Sent" in the list and the reply shows "Sent" twice (direction and status) in the thread.
- On the Spend page at phone width the Limit and This week columns start off screen, as in SP.4. The agent column is not sticky.
- Opening an agent page created an empty "Conversation with Fake echo" (No tasks) in the conversation list. Not spend code.
- At phone width the top bar shows only Home, the bell and Menu. I opened `/spend` by URL and did not check the Menu sheet.
