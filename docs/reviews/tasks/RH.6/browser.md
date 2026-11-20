# RH.6 browser verification

Branch task/RH.6-shell-top-bar, commit 0aedea2e. Verified in a real headless Chromium (agent-browser, session `rh6-verify`) against `vite dev --port 3171` started from the worktree, signed in with the dev login. Desktop is 1280x800 and phone is 390x844. Extra spot check at 1024x768.

## Setup and data

The local D1 started with a workspace and no agents. I seeded the LOCAL database only, from `apps/web` with `wrangler d1 execute DB --local`:

- `bun scripts/dev/seed-fake-agent.ts` made the agent "Fake echo" (fake runtime). I set its `owner_user_id` to the dev user so its requests count as "Mine".
- SQL in `tmp/RH.6/seed*.sql` added sessions, runs and a pending `run_requests` row of kind `question` ("Which day should we launch on?" for the desktop answer flow, "Which venue should we book?" for the phone one), a second running run for the Working section, and one artifact plus a `sidebar` pin for the Pinned section.
- Requests reach `desk.railSources` through `requests.listPending`, so a pending `run_requests` row on a visible agent is enough. Nothing touched remote D1.

How failures were detected: agent-browser's `network requests` has no status codes. Chrome writes a console error ("Failed to load resource ... status NNN") for every 4xx/5xx, so I treated the console log as the failure detector, read it after every flow, and also checked `performance.getEntriesByType("resource")` for `responseStatus >= 400` on /home, /desk, /library, /agents and a thread page (none). The known favicon.ico 404 did not show up at all.

Findings that apply to every flow, so they are stated once here:

1. Sign-in only: each `/api/dev-login` run logs one console error, `Failed to load resource: 400`. The network log shows it is Clerk's `POST /v1/client/sign_ins` during the ticket redemption on `/dev-login`. The diff for RH.6 does not touch any login file. I count it as outside the shell, but it is a console error.
2. Flow 6 only, desktop: three `409 (Conflict)` errors and a "Run cannot be claimed" toast. I caused them by sending three messages into a thread whose seeded fake-runtime run cannot be claimed in this environment. Not a shell problem. I did not send messages on the phone.
3. No other console errors, no failed requests, in any flow at either size.

## Flow 1. Top bar content

Desktop steps: open /home, snapshot, read the bar text, read `scrollWidth`, check for a rail.
Saw (desktop-1.png): one top bar, in order: workspace menu "Dev Workspace" (with the switcher chevron), Home, Files, Find with a `Ctrl K` hint, Assistant, "Needs you" with an orange count badge (1 when a request waits, no badge at 0), New agent, theme toggle ("Dark", cycles to Light/Auto, light theme seen in desktop-16.png), user button. No Spend anywhere in the bar or in Find, and no `/spend` route. No sidebar element in the DOM (`[data-sidebar]` absent), no footer tab bar. The only footer is the normal page footer "© 2026 Agentum". `scrollWidth` 1280 = `innerWidth` 1280. The user button opens Clerk's menu with Manage account, Your sign-ins, Sign out (desktop-17.png).
At 1024x768 (desktop-18.png) Assistant and New agent become icon-only and everything still fits, `scrollWidth` 1024.

Phone steps: set viewport 390x844, open /home, snapshot, open the Menu sheet.
Saw (phone-1.png): the bar holds only Home, Needs you (bell and count) and a Menu button. No rail, no footer tabs. `scrollWidth` 390 = `innerWidth` 390.
Menu sheet (phone-2.png): workspace menu, Find, Files, New agent, Assistant, theme toggle, the user's email, Manage account, Your sign-ins, Sign out, and a Close button. That is the full list the spec asks for.

Console and network: none beyond note 1.
Verdict: PASS at both sizes.

## Flow 2. Reach every page

Desktop steps: from the bar click Files, Home, New agent. Open Find with Ctrl+K, type the name, pick the option, and read URL and heading. Direct visit for the agent page and for `/desk?view=board`.
Phone steps: Menu, then Find (and Files, New agent from the menu, Home from the bar), then the same picks. Phone has no Ctrl+K button in the bar, so Find is reached through the Menu.

| Page | Desktop result | Phone result |
|---|---|---|
| Home (bar) | /home, "Home" | /home, "Home" |
| Files (bar or menu) | /library, "Library" | /library, "Library" |
| New agent (bar or menu) | /agents/new, "New agent" | /agents/new, "New agent" |
| Assistant (Find) | /home?assistant=new, panel opens | same |
| Desk (Find) | /desk?view=board, "Desk" and the three board lanes | same |
| Conversations | /sessions | /sessions |
| Log | /log | /log |
| Q&A | /qa | /qa |
| Inbox | /inbox | /inbox |
| Map | /map | /map |
| Jobs | /jobs | /jobs |
| Skills | /skills | /skills |
| Library (Find "Library") | /library | /library |
| Artifacts | /artifacts | /artifacts |
| Apps | /artifacts?kind=app | /artifacts?kind=app |
| Enrol a machine | /settings/machines, "Machines" | same |
| Agents | /agents, "Agents" | /agents, "Agents" |
| One agent (Find agent list, "Fake echo") | /threads/<id>, "Conversation with Fake echo" (Find opens the agent's main thread, existing TH.3 behaviour). Direct /agents/<id> also renders. | same |
| Settings: Your sign-ins, Model providers, Apps (connectors), Passwords and keys, Artifacts, API keys, Connected apps, Agent connections, Timezone | all nine load at their /settings/* URL with the right heading | all nine load, same |

Every page reached had `scrollWidth` equal to `innerWidth` (1280 and 390). `/desk?view=board` opens the Board (Needs you, Running and Done today lanes, desktop-4.png and phone-6.png). One Find quirk, not a defect: typing "Agents" and pressing Enter picks Home first, because Home carries the hint "Agents". I picked the exact option each time.
Screenshots: desktop-2.png (Find list), desktop-3.png (Inbox), desktop-4.png (Board), desktop-5.png (Assistant panel), phone-5.png (Find opened from the Menu), phone-6.png (Board on phone), phone-7.png (Assistant on phone).
Console and network: none beyond note 1.
Verdict: PASS at both sizes.

## Flow 3. Needs you drawer

Steps at each size: load the page, click the Needs you button, read the dialog box, screenshot, press Escape, reopen, click Close.
Pages checked on desktop: /home, /desk, /desk?view=board, /library, /agents, /agents/<id>, /agents/new, /sessions, /log, /qa, /inbox, /map, /jobs, /skills, /artifacts, /artifacts?kind=app, all nine /settings/* pages, /settings/machines, and /home?assistant=new. Pages checked on phone: /home, /desk, /desk?view=board, /library, /agents, /agents/<id>, /agents/new, /sessions, /log, /qa, /inbox, /map, /jobs, /skills, /artifacts, /artifacts?kind=app, /settings/* (all), and a thread page.
Saw: on every page the drawer opens as a left sheet (`data-side="left"`, x 0, 384px wide on desktop, full 390px on phone), titled "Needs you", closes with Escape and closes with the Close button, 100 percent of the time. With the Assistant panel open, the drawer opens next to it and Escape closes only the drawer.
Contents: the Mine/Everyone toggle with counts (Everyone toggles, pressed state follows), the Needs you section with the request row ("Launch day, Fake echo asks"), "N done today" (0, then 1, then 2 as I answered requests), Working ("Working 1", later "Working · 5 running" and 6 running, a collapsible row on phone) and Pinned ("RH6 pinned page") when present. With nothing waiting the list says "Nothing needs you." The count in the button matched the list every time (1 and 1, then none and 0).
Screenshots: desktop-6.png (drawer, 1 request), desktop-7.png (with Working), desktop-8.png (on /desk), desktop-9.png (with the Assistant open), desktop-10.png (on /library), desktop-15.png (all sections: Needs you empty, done, Pinned, Working), phone-8.png (/home), phone-9.png (/library).
Console and network: none beyond note 1.
Verdict: PASS at both sizes.

## Flow 4. Answer a request from the drawer

Desktop steps: open /library, the button reads "Needs you, 1 waiting", open the drawer, click the "Launch day" row, answer in the pane, wait for the poll.
Saw: the drawer closed on click and the URL became `/desk?item=01RH6REQ...Q1` with the question and its choices in the item pane (desktop-11.png). I chose Monday and clicked Send answer. The pane changed to "Nothing needs you" (desktop-12.png) and the DB row shows `status=answered`, `answered_via=web`, answer `{"Which day should we launch on?": "Monday"}`. After the 10 second poll the bar count badge was gone.
Phone steps: same from /library: the drawer (phone-9.png), the "Venue" row, `/desk?item=...Q2` in a full-width pane (phone-10.png), pick "Harbour Hall", Send answer, the page shows "Nothing needs you" (phone-11.png), and after the poll the badge was gone. `scrollWidth` 390 throughout.
Console and network: none beyond note 1.
Verdict: PASS at both sizes.

One copy note, not a failure: the empty state reads "N things are in hand. Anything new will show up on the left." The shell has no permanent left rail now, and the new items appear in the drawer behind the Needs you button. The text may be stale after RH.6.

## Flow 5. Phone Menu

Steps (390x844): open Menu, click the workspace button, press Escape, click Manage account, press Escape, reopen Menu, click Find, then Menu and Assistant, then Menu and Close.
Saw: the workspace menu opens inside the sheet (Dev Workspace with a check, Manage members, Invite people, Settings, New workspace, phone-3.png). Escape closes only that menu and leaves the sheet. Manage account closes the sheet and opens Clerk's account modal (phone-4.png, only that dialog remains). Find from the Menu closes the sheet and opens Find (phone-5.png). Assistant from the Menu closes the sheet and opens the assistant panel at `/home?assistant=new` (phone-7.png). The sheet closes with its Close button. Files and New agent from the Menu also close the sheet and navigate (flow 2).
Console and network: none beyond note 1.
Verdict: PASS.

## Flow 6. Thread page

Steps: Find opened the agent's main thread (`/threads/01M7VPH3...`) and I opened the seeded `/threads/01RH6SESSION...AA` ("RH6 verify thread", a conversation with a past task and a user message). At each size I read `scrollHeight` against `innerHeight`, the composer's rect, tried `scrollTo(0, 9999)`, and on desktop I typed three long messages with Ctrl+Enter.
Saw: desktop `scrollHeight` 800 = `innerHeight` 800, `scrollWidth` 1280, composer ("Reply", textarea, Attach, Library, Send) pinned to the bottom (desktop-13.png). When the textarea grew with long text, the composer stayed at the bottom and the page did not scroll (`scrollHeight` still 800, desktop-14.png). Phone `scrollHeight` 844 = `innerHeight` 844, `scrollWidth` 390, `scrollY` stays 0 after `scrollTo`, composer pinned (phone-12.png).
Observation: on the phone the floating palm-tree button at the bottom-right sits over the Send button. That button is not in the RH.6 diff, so I think it was there before this change, but it hides the main action in the composer at 390px.
Console and network: desktop shows the three 409 errors from note 2, caused by my message sends and the unclaimable fake run. Phone: none beyond note 1.
Verdict: PASS for the layout at both sizes. The three 409s are from the test setup, not from the shell.

## Final verdict

All six flows work at 1280x800 and 390x844, so the layout and behaviour pass. By the strict reading of the rule (no console errors, no failed requests), the run is not clean, because of two sources that are not the shell: the Clerk dev-login 400 at sign-in (note 1) and three 409s from my own message sends in flow 6 on desktop (note 2). Nothing in the shell, drawer, Find or Menu produced an error. Verdict: PASS for RH.6, with those two items disclosed.

Two minor things for the controller: the stale "show up on the left" copy in the empty Needs you state, and the floating button over Send on the phone composer.

Screenshots are in this folder as desktop-1.png to desktop-18.png and phone-1.png to phone-12.png. Scratch logs and the seed SQL are in `tmp/RH.6/` (untracked). The dev server and the browser session are stopped.
