Verdict: fail

F4 fails on one point: `?mail=1` lands on Keys with the Mail sheet open, but the address bar does not get `?tab=keys`. Every other flow passes at both sizes.

Run: headless Chromium (agent-browser session rh4-verify3), vite dev on port 3141, commit 79b7e995, local D1 only. Fresh agent "Sorter" (Cloud runtime, selectable), renamed "Sorter Pro" on desktop and "Sorter Mobile" on phone. Owner and Backup selects show: the workspace has Dev User, Admin HM and Member2 HM (Backup options: No backup, Admin HM, Member2 HM). Desktop 1280x800, phone 390x844.

## Failure

F4, `?mail=1` (both sizes). Steps: open /agents/<id>?mail=1. Expected (brief): Keys tab, Mail sheet open, address bar `?tab=keys&mail=...`. Actual: Keys tab selected and the Mail dialog open ("Mail / Sorter Pro / No mail yet."), but the URL becomes `?mail=%221%22` (the value is JSON-quoted) and has no `tab=keys`. Closing the dialog rewrites the URL to `?tab=keys`. `legacySheetSearch` only redirects URLs that carry `sheet=`, and `tabs.test.ts` asserts `legacySheetSearch({ mail: "1" })` is null, so this is the coded behaviour. If the brief is the intent, add the redirect; if not, relax the brief. All six `?sheet=` links redirect correctly.

## Console and network

- Console errors other than known noise: none, either size. Uncaught page errors: none.
- Failed requests (HTTP 400 or above) and aborted requests: none. No "Failed to load resource" or "Failed to fetch" console line appeared in either phase (console cleared before F1 on desktop and before the phone phase). The agent-browser network log stayed empty, so this rests on the console and page-error output.
- Known noise, listed separately: 13 `[Server] LOG ... pi-run-start.ts:170` error lines per phase ("PiRun: starting run ...: Network connection lost") and 13 warnings "PiRun: MCP server harbourmaster did not list its tools Network connection lost", from the runs started in F2. Other warnings: Clerk development keys, Vite and React DevTools info.

## Flows

| Flow | Desktop | Phone |
|---|---|---|
| F1 | pass | pass |
| F2 | pass | pass |
| F3 | pass | pass |
| F4 | fail (`?mail=1` URL) | fail (same) |
| F5 | pass | pass |
| F6 | pass | pass |
| F7 | pass | pass |

### F1
Open /agents/<id>. Header: avatar, "Sorter", "Sorts notes into folders · Owner: Dev User", address chip sorter-3@agents.rockyshoreslabs.io, "Runs on Cloud" chip, Edit, Run now. Tabs in order Chat (selected), Work, Files, Knows, Keys, Jobs, Settings. scrollWidth equals viewport at both sizes. On phone the tab list scrolls inside itself (474 inside 390, Settings off-screen). Shots: desktop-1.png, phone-1.png.

### F2
Chat opens the main conversation with a composer. "Open main conversation" and "New conversation" end inside the conversation card (desktop buttons end at 538 and 497, card 344 to 664; phone 210 and 354, card 16 to 374). Phone stacks the list above the thread. Sent "Hello Sorter desktop" / "Hello Sorter phone": URL stayed /agents/<id>; Work then listed the new task as the top entry with no reload. Shots: desktop-2a.png, desktop-2b.png, phone-2a.png, phone-2b.png.

### F3
Each tab click sets ?tab=<name>.
- Files: folders agents/sorter-3 (home, read and write) and wiki (read, suggestions); "+ Add folder" opens the Add folder dialog; "Open home folder" goes to /library?dir=agents%2Fsorter-3. Shots: desktop-3a-files, 3b-library, 3c-addfolder; phone-3a-files, 3b-library, 3c-addfolder.
- Knows: Instructions, Voice, Skills (assign select). Voice typed, Save clicked (button appears after typing), reloaded: persisted ("Friendly and terse" desktop, "Calm on phone" phone). Shots: desktop-3d-knows, phone-3d-knows.
- Keys: Tools (Browser switch, connectors, secrets), Channels (Slack form), Works with (Hands to, Subagents, Peers), "Ask me before it..." radios. Changed to "Ask before it acts outside" (desktop) and "Ask before everything" (phone); reload: persisted. Shots: desktop-3e-keys, 3f-keys-ask; phone-3e-keys.
- Jobs: Create trigger dialog (Name) and Create routine dialog (Name, Schedule, Hour, Minute, Timezone, Prompt) open. Shots: desktop-3g-trigger, 3h-routine; phone-3f-trigger, 3g-routine.
- Settings: Runs on Cloud with Move agent, Advanced, Computer ("Add a computer"), Owner and Backup selects (two comboboxes), Edit agent form (Name, Instructions, Model), Save changes, Archive agent. Renamed and saved: h1 updated at once. Shots: desktop-3i-settings, 3j-renamed; phone-3h-settings, 3i-renamed.
No horizontal page overflow on any tab on phone.

### F4
`?sheet=tools` Keys, `skills` Knows, `handsTo` Keys, `startsOn` Jobs, `channels` Keys, `edit` Settings: each lands on the tab and the address bar shows `?tab=<name>` (both sizes). `?mail=1`: see Failure. Clicking Work after any of these gives `?tab=work`, the old param is gone. Shots: desktop-4a-mail, 4b-tools; phone-4a-mail, 4b-skills.

### F5
Settings, Archive agent, confirm: redirects to /agents. Reopened: banner "This agent is archived. It doesn't run and isn't offered anywhere." with Restore, "Archived" chip, tabs still switch. Inventory per tab (every button, input, select, switch, radio, textarea and link inside the tab panel; "disabled" judged with :disabled, all those controls sit in a disabled fieldset). Identical at both sizes:
- Chat: links only (conversation row, "All conversations"). No composer. No controls.
- Work: links only (task row, "All tasks").
- Files: "+ Add folder" disabled; "Open home folder" link (/library?dir=...), enabled, navigation only.
- Knows: note shown; the Voice textarea, Start dictation and Choose microphone are disabled. No skill assign form.
- Keys: note shown in place of connectors/secrets, Channels and Hands to. Remaining: Browser switch, Subagents switch, three ask-level radios, Advanced, Built-in tools toggles, all disabled; link "Agent connections" (/settings/agent-connections), enabled, navigation to a workspace settings page.
- Jobs: note shown; remaining control is the "Mail to ... starts tasks" switch, disabled. No Create trigger or Create routine.
- Settings: note shown; no Owner or Backup selects, no agent form. Remaining: Move agent and Advanced disabled; link "Add a computer" (/settings/machines), enabled, navigation.
No `/connect` link exists on any tab, no dialog is open or reachable. Real clicks on the Browser switch (Keys) and "+ Add folder" (Files) timed out (not enabled), no dialog opened. Restore removes the banner and notes; Keys shows Add a connector, Connect Slack and the rest again. Shots: desktop-5a-confirm, 5b-archived, 5-chat, 5-work, 5-files, 5-knows, 5-keys, 5-jobs, 5-settings, 5c-restored; phone-5a-confirm, 5b-archived, 5-chat ... 5-settings, 5c-restored.

### F6
Focus on Chat: ArrowRight goes Work then Files, ArrowLeft back to Work, End to Settings, Home to Chat, ArrowLeft from Chat wraps to Settings. Focus moves without selecting (manual activation). Same at both sizes. Shots: desktop-6-keyboard, phone-6-keyboard.

### F7
/map, Editor, select the agent node: inspector links Knows, Keys, Jobs, Settings go to ?tab=knows, keys, jobs, settings and land on the matching selected tab; "Open agent room" goes to /agents/<id> with Chat selected. The extra "Profile" link (to /agents/<id>) is next to Close inspector. Phone node selected by mouse click at its coordinates; the phone inspector links were activated with a scripted click. Shots: desktop-7a-map, 7b-inspector, 7c-settings-landing; phone-7a-map, 7b-inspector, 7c-settings-landing.

## Observations
- The Chat thread's inner tab bar also uses role=tab with names like "Files 0", so a role-based locator for the "Files" tab matches two elements. Not a user-facing failure.
- Archived Keys still renders Browser, Subagents and the ask-level controls (disabled) next to the note.
