Verdict: pass

All seven flows work at 1280x800 and 390x844. Headless Chromium 156 (agent-browser session rh4-verify2), vite dev on port 3131, commit dff21ef0, local D1 only. Agent used: a fresh "Sorter" (renamed "Sorter Pro" on desktop, "Sorter Phone" on phone). The earlier "Cloud" runtime option was already selectable, so no key row was inserted.

## Console and network

- Failed requests (status 400 or above) in resource timing after each flow: none on any agent, map or library page, at either size. Only one console line "Failed to load resource: 400" appeared, once, right after the sign-in redirect pages (/login, /api/dev-login, /dev-login) before any agent page was opened. It did not recur in the phone phase (console cleared first) or in any later page load. I read it as part of the Clerk dev sign-in, not RH.4, but I did not capture its URL.
- Aborted requests: a few tRPC polls (desk.rail, artifacts.pins, qa.openCount, dictation.status) log "Failed to fetch" when I did a full page load while they were in flight. These come from my own `open` navigations, not from tab switching.
- Uncaught page errors: none.
- Known noise: dev server relays `[Server] LOG ... pi-run-start.ts:170` (PiRun ... Network connection lost) as console errors, about 25 lines over both phases, and as warnings "PiRun: MCP server harbourmaster did not list its tools Network connection lost". Both come from the runs started in F2.
- Other warnings: Clerk development keys, Vite and React DevTools info.

## Flows

| Flow | Desktop | Phone |
|---|---|---|
| F1 | pass | pass |
| F2 | pass | pass |
| F3 | pass | pass |
| F4 | pass | pass |
| F5 | pass | pass |
| F6 | pass | pass |
| F7 | pass | pass |

### F1 header and default tab
Open /agents/<id>. Header shows avatar, name, "job line · Owner: Dev User", address chip, "Runs on Cloud" chip, Edit and Run now. Chat is selected. Tabs in order: Chat, Work, Files, Knows, Keys, Jobs, Settings. Page scrollWidth equals viewport (1280 and 390). On phone the tab list scrolls inside itself (474 inside 390) with Settings off-screen. Shots: desktop-1.png, phone-1.png.

### F2 chat
Desktop: main conversation with composer (Message box, Send). The list has "Open main conversation", "New conversation", the conversation, "All conversations". Card width 318, buttons end at 538 and 497, card ends at 663 (inside). Sent a message: URL stayed /agents/<id>. Work then listed "Hello Sorter, sort these notes" at once, no reload. Shots: desktop-2a-sent.png, desktop-2b-work.png.
Phone: list stacked above the thread, card 356 wide, buttons end at 210 and 354, card ends at 373 (inside), page scrollWidth 390. Sent "Phone hello again": URL stayed /agents/<id>, Work listed it as "Phone hello again" without reload. Shots: phone-2a-chat.png, phone-2b-sent.png, phone-2c-work.png.

### F3 tabs
Each click set ?tab=<name> and showed its panel, no horizontal overflow on phone.
- Files: folders agents/sorter-2 (home, read and write) and wiki (read, suggestions), "+ Add folder", "Open home folder" opens /library?dir=agents%2Fsorter-2.
- Knows: Instructions, Voice, Skills. Voice typed, Save clicked, reloaded: value persisted ("Friendly and terse" desktop, "Calm on phone" phone).
- Keys: Tools (Browser switch, connectors, secrets), Channels (Slack form), Works with (Hands to, Subagents, Peers), "Ask me before it..." card. Ask level changed ("Ask before it acts outside" on desktop, "Ask before everything" on phone), reloaded: persisted.
- Jobs: Triggers and Routines. Create trigger dialog (Name) and Create routine dialog (Name, Schedule, Hour, Minute, Timezone, Prompt) open.
- Settings: Runs on Cloud with Move agent, Computer, Owner and Backup, Edit agent form, Save changes, Archive agent. Renamed and saved: h1 updated at once.
Shots: desktop-3b-files, 3c-library, 3d-knows-voice-saved, 3e-keys, 3f-jobs-trigger, 3g-jobs-routine, 3h-settings, 3i-settings-renamed; phone- has the same names.

### F4 old links
?sheet=tools Keys, skills Knows, handsTo Keys, startsOn Jobs, channels Keys, edit Settings, ?mail=1 Keys with the Mail dialog open ("Mail / Sorter ... / No mail yet"). Same at both sizes. Clicking Work afterwards gave ?tab=work (sheet dropped). The old ?sheet= param stays in the URL on arrival. Shots: desktop-4a-tools, desktop-4b-mail, phone-4a-skills, phone-4b-mail.

### F5 archive
Settings, Archive agent, Archive in the confirm dialog, then redirect to /agents. Reopened: banner "This agent is archived" with Restore, "Archived" chip, tabs still switch. Counts of panel controls (buttons, inputs, selects, textareas, switches, radios, excluding tab buttons, links and the banner), identical at both sizes:

| Tab | matches :disabled | not disabled |
|---|---|---|
| Chat | 0 | 0 (composer replaced by an archived notice) |
| Work | 0 | 0 (links only) |
| Files | 1 | 0 |
| Knows | 5 | 0 |
| Keys | 16 | 0 |
| Jobs | 3 | 0 |
| Settings | 13 | 0 |

Real click on the Browser switch in Keys and on "Create trigger" in Jobs: both timed out after 25 s with "element is not enabled" (both sizes). Restore removed the banner. Shots: desktop-5a-confirm, 5b-archived, 5c-archived-keys, 5d-restored; phone-5a-confirm, 5b-archived, 5c-archived-keys, 5d-archived-chat, 5e-restored.

### F6 keyboard
Focus on Chat: ArrowRight goes Work then Files, ArrowLeft back to Work, End to Settings, Home to Chat, ArrowLeft from Chat wraps to Settings. Focus moves without changing the selected tab. Same at both sizes. Shots: desktop-6-keyboard, phone-6-keyboard.

### F7 map
/map, Editor, select the agent node: inspector links Knows, Keys, Jobs, Settings go to ?tab=knows, keys, jobs, settings and land on the matching selected tab; "Open agent room" goes to /agents/<id> with Chat selected. There is also an extra "Profile" link to /agents/<id>. Same at both sizes (phone node had to be selected by a mouse click at its coordinates). Shots: desktop-7a-map, 7b-inspector, 7c-settings-landing; phone-7a-map, 7b-inspector, 7c-settings-landing.

## Observations (not failures)
- Archived Chat and Work show no controls to disable, so those rows are 0 and 0.
- Opening ?mail=1 rewrites the URL to ?mail=%221%22.
