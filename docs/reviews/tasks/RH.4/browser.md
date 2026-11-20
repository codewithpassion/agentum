Verdict: pass

F4 and F5 work at both sizes (desktop 1280x800, phone 390x844) at commit 8b598bef, and F1, F2, F3, F6 and F7 were all pass at 79b7e995. Two points for the dispatcher, neither judged a failure: the mail links read `?mail=1&tab=keys` (same params, `mail` before `tab`, not `?tab=keys&mail=1`), and the one console error class is two "Failed to load resource ... 404" lines per load of `?mail=thread-nope-123`, the deliberately nonexistent thread id (the Mail sheet shows "Mail thread not found").

Run: headless Chromium (agent-browser session rh4-verify4), vite dev on port 3151, commit 8b598bef, local D1 only. Fresh agent "Verifier" (id 01M7V59QB0V828G1F08Y620HWD, Cloud runtime, mailbox verifier@agents.rockyshoreslabs.io), archived and restored once per size. F4 and F5 re-walked at 8b598bef; F1, F2, F3, F6 and F7 walked at 79b7e995, not repeated.

## Console and network

- Console errors other than known noise, both sizes: only the two 404 lines from `?mail=thread-nope-123` (one page load, both sizes). The same load via the resource-timing API shows no status >= 400 entry, so the 404 comes from the thread lookup request, not a static asset. No other console error, no uncaught page error. Loading the other seven old links, every tab (archived and restored) and all Settings flows gave none.
- Failed requests (HTTP 400 or above): the thread lookup above, only. The agent-browser network log stayed empty ("No requests captured"), so this rests on the console, page-error output and resource-timing status checks.
- Known noise: no PiRun lines appeared in this walk (no task was run). Other lines: Vite debug "connecting/connected".

## Flows

| Flow | Desktop | Phone |
|---|---|---|
| F1 | pass (walked at 79b7e995, not repeated) | pass (same) |
| F2 | pass (same) | pass (same) |
| F3 | pass (same) | pass (same) |
| F4 | pass (8b598bef) | pass (8b598bef) |
| F5 | pass (8b598bef) | pass (8b598bef) |
| F6 | pass (79b7e995, not repeated) | pass (same) |
| F7 | pass (79b7e995, not repeated) | pass (same) |

### F1 (walked at 79b7e995, not repeated)
Open /agents/<id>. Header: avatar, "Sorter", "Sorts notes into folders · Owner: Dev User", address chip sorter-3@agents.rockyshoreslabs.io, "Runs on Cloud" chip, Edit, Run now. Tabs in order Chat (selected), Work, Files, Knows, Keys, Jobs, Settings. scrollWidth equals viewport at both sizes. On phone the tab list scrolls inside itself (474 inside 390, Settings off-screen). Shots: desktop-1.png, phone-1.png.

### F2 (walked at 79b7e995, not repeated)
Chat opens the main conversation with a composer. "Open main conversation" and "New conversation" end inside the conversation card (desktop buttons end at 538 and 497, card 344 to 664; phone 210 and 354, card 16 to 374). Phone stacks the list above the thread. Sent "Hello Sorter desktop" / "Hello Sorter phone": URL stayed /agents/<id>; Work then listed the new task as the top entry with no reload. Shots: desktop-2a.png, desktop-2b.png, phone-2a.png, phone-2b.png.

### F3 (walked at 79b7e995, not repeated)
Each tab click sets ?tab=<name>.
- Files: folders agents/sorter-3 (home, read and write) and wiki (read, suggestions); "+ Add folder" opens the Add folder dialog; "Open home folder" goes to /library?dir=agents%2Fsorter-3. Shots: desktop-3a-files, 3b-library, 3c-addfolder; phone-3a-files, 3b-library, 3c-addfolder.
- Knows: Instructions, Voice, Skills (assign select). Voice typed, Save clicked (button appears after typing), reloaded: persisted ("Friendly and terse" desktop, "Calm on phone" phone). Shots: desktop-3d-knows, phone-3d-knows.
- Keys: Tools (Browser switch, connectors, secrets), Channels (Slack form), Works with (Hands to, Subagents, Peers), "Ask me before it..." radios. Changed to "Ask before it acts outside" (desktop) and "Ask before everything" (phone); reload: persisted. Shots: desktop-3e-keys, 3f-keys-ask; phone-3e-keys.
- Jobs: Create trigger dialog (Name) and Create routine dialog (Name, Schedule, Hour, Minute, Timezone, Prompt) open. Shots: desktop-3g-trigger, 3h-routine; phone-3f-trigger, 3g-routine.
- Settings: Runs on Cloud with Move agent, Advanced, Computer ("Add a computer"), Owner and Backup selects (two comboboxes), Edit agent form (Name, Instructions, Model), Save changes, Archive agent. Renamed and saved: h1 updated at once. Shots: desktop-3i-settings, 3j-renamed; phone-3h-settings, 3i-renamed.
No horizontal page overflow on any tab on phone.

### F4 (walked at 8b598bef)
Final address bar after load, identical at both sizes (prefix http://localhost:3151/agents/<id>):

| Link | Tab selected | Final URL |
|---|---|---|
| ?sheet=tools | Keys | ?tab=keys |
| ?sheet=skills | Knows | ?tab=knows |
| ?sheet=handsTo | Keys | ?tab=keys |
| ?sheet=startsOn | Jobs | ?tab=jobs |
| ?sheet=channels | Keys | ?tab=keys |
| ?sheet=edit | Settings | ?tab=settings |
| ?mail=1 | Keys, Mail sheet open, list view ("Mail / Verifier / No mail yet.") | ?mail=1&tab=keys |
| ?mail=thread-nope-123 | Keys, Mail sheet open ("Back", "Mail thread not found") | ?mail=thread-nope-123&tab=keys |

`mail=1` is plain (not `mail=%221%22`), which fixes the earlier failure. The only difference from the brief is parameter order (`mail` before `tab`). Other checks, both sizes:
- Close the Mail sheet from `?mail=1`: URL becomes `?tab=keys`, dialog gone.
- Click Work from a redirected URL (`?sheet=tools` then Work): URL becomes `?tab=work`, no `sheet` left. With a Mail sheet open the modal overlay blocks tab clicks (a click on the Work tab was refused as blocked), so the tab-click check was made from `?sheet=tools`.
- The header address chip (button "verifier@agents.rockyshoreslabs.io") on the Work tab opens the Mail sheet ("Mail / Verifier / No mail yet."): tab stays Work, URL `?mail=1&tab=work`.
- Phone: no horizontal overflow (scrollWidth 390).
Shots (letters a to h in link order above, i close, j mail open with tab click blocked (desktop only), k Work after redirect, l chip on Work): desktop-4a..4l.png, phone-4a..4i, 4k, 4l.png.

### F5 (walked at 8b598bef)
Settings, Archive agent, confirm "Archive": redirects to /agents. Reopened /agents/<id>: banner "This agent is archived. It doesn't run and isn't offered anywhere." with Restore; the address chip is disabled; tabs still switch (clicking Keys sets ?tab=keys). Inventory per tab: every button, input, select, textarea, switch, radio and link inside the tab panel; "disabled" judged with el.matches(':disabled'). Identical at both sizes (phone counts match: 3 enabled, 14 disabled across the panels).
- Chat: text "This agent is archived, so it takes no new messages." No composer. Enabled links: the conversation row (/threads/<id>) and "All conversations" (/sessions?agent=<id>). No buttons.
- Work: "No tasks yet" (the fresh agent has no tasks, so the task-row links could not be listed). Enabled link: "All tasks" (/sessions?agent=<id>).
- Files: library folders agents/verifier (home, read and write) and wiki (read, suggestions) shown. No "Open home folder" link. "+ Add folder" disabled. No links.
- Knows: full instruction text, no "Show more". Voice textarea disabled, "Start dictation" and "Choose microphone" disabled. The note "This agent is archived. Restore it to change this." sits in place of Skills. No links.
- Keys: one note at the top. Remaining, all disabled: three ask-level radios, "Advanced" (Model, environment, network, turn limit) with its inner button, "Built-in tools 0 of 10 ask" toggle and its "Ask before every Built-in tools action" switch. No links, no `/connect/` link, no Connectors, Secrets, Slack, Hands to, Browser or Subagents controls.
- Jobs: the note replaces Triggers and replaces Routines (two notes). Remaining: the "Mail to verifier@agents.rockyshoreslabs.io starts tasks" switch, disabled. No links, no Create trigger or Create routine.
- Settings: Runs on Cloud card with "Move agent" disabled and "Advanced" disabled; a note in place of Computer, a note in place of Owner and Backup, a note in place of the Edit agent form. No links, no "Add a computer" link.
Restore from the banner: banner and every archived note disappear (no "archived" text left on any tab at either size). Chat shows Open main conversation and New conversation again, Files has "Open home folder" back, Keys starts with Tools and connectors, Jobs has Create trigger and Create routine, Settings shows the Computer card with its normal controls. A few controls stay disabled after restore (3 in Chat, 3 in Knows, 1 in Keys, 2 in Settings), which is their normal state on an active agent, not an archive leftover; their causes were not examined.
Shots: desktop-5a.png and phone-5a.png (archive confirm), 5b (archived banner on Chat), 5-chat, 5-work, 5-files, 5-knows, 5-keys, 5-jobs, 5-settings, 5c (restored) for both sizes.

### F6 (walked at 79b7e995, not repeated)
Focus on Chat: ArrowRight goes Work then Files, ArrowLeft back to Work, End to Settings, Home to Chat, ArrowLeft from Chat wraps to Settings. Focus moves without selecting (manual activation). Same at both sizes. Shots: desktop-6-keyboard, phone-6-keyboard.

### F7 (walked at 79b7e995, not repeated)
/map, Editor, select the agent node: inspector links Knows, Keys, Jobs, Settings go to ?tab=knows, keys, jobs, settings and land on the matching selected tab; "Open agent room" goes to /agents/<id> with Chat selected. The extra "Profile" link (to /agents/<id>) is next to Close inspector. Phone node selected by mouse click at its coordinates; the phone inspector links were activated with a scripted click. Shots: desktop-7a-map, 7b-inspector, 7c-settings-landing; phone-7a-map, 7b-inspector, 7c-settings-landing.


## Observations
- The Chat thread's inner tab bar also uses role=tab with names like "Files 0", so a role-based locator for the "Files" tab matches two elements. Not a user-facing failure.
- Archived Keys still renders the ask-level radios, Advanced and Built-in tools controls (disabled) next to the single note.
