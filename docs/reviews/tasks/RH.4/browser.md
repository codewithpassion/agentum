Verdict: fail

F5 fails at both sizes because most controls inside an archived agent's tabs stay enabled. Every other flow works at 1280x800 and 390x844. Browser: headless Chromium 156 (agent-browser session rh4-verify), dev server on port 3111, commit 1dd87746, local D1 only.

Setup notes. There was no runtime, so I inserted a dummy `workspace_anthropic_keys` row in the local D1 to make "Cloud" selectable (the Settings key form tried to validate a fake key with Anthropic and was refused, so that one call went out). Runs started from Chat then fail with "Network connection lost". This is expected here. Agents used: "Sorter" (renamed to "Sorter Pro", then "Sorter Phone") and "Phone Sorter".

## Console and network

- Failed requests (HTTP status 400 or above, or aborted): none seen. I read the resource timing entries of the current page at the end of each flow and checked the vite log. Entries are lost on a full page load, so a failure that happened mid-flow before a reload could be missed.
- Uncaught page errors: none.
- Console errors: only the dev server relaying `[Server] LOG ... pi-run-start.ts: PiRun: starting run ...: Network connection lost`. These come from the agent runs I started in F2, which cannot reach a model. They repeat while a run retries (about 9 entries). I count them as environment noise, not RH.4 defects.
- Console warnings (not errors): Clerk development keys warning; "PiRun: MCP server harbourmaster did not list its tools Network connection lost" (same cause); the headless Chromium WebGL fallback warnings from the map page; Vite debug and React DevTools info lines.

## Defects

1. F5, archived agent. The Chat composer is replaced by "This agent is archived, so it takes no new messages", and every control in Settings is disabled. Controls in the other tabs stay enabled: Keys has about 15 (Browser switch, Subagents switch, ask-level radios, Slack fields and the rest), Jobs has 3 (Create trigger, mail switch, Create routine), Knows has 2 (the Skill select and its Assign button are disabled, but the Voice textbox is not; Voice Save was not tried on an archived agent), and Files has 1 (+ Add folder). Steps: archive an agent, open `/agents/<id>`, click Keys, toggle Browser. Expected: disabled, as the task describes. Actual: toggles. The Keys screenshot is desktop-5e-archived-keys.png.
2. Chat, desktop (minor). In the conversation list card the "New conversation" button runs about 17px past the card's right border (see desktop-1.png).
3. Work, stale list (minor). After sending a message in Chat in the same session, clicking Work still showed "No tasks yet". A reload shows the task. The list is cached and not refreshed when the tab mounts.

## Other observations

- "Open main conversation" navigates to `/threads/<id>` once the conversation has tasks. This is not a redirect on send, and the empty inline thread sends fine (F2). The `/threads/<id>` page itself overflows horizontally on a phone (scrollWidth 424 against 390). That is outside the RH.4 page.
- A first test on a phone that clicked "Open main conversation" first and then sent a message ended on `/threads/...`. That is this behaviour, not a failure of F2. The phone F2 below used a fresh agent.
- After a restore the page keeps whatever `?tab=` was open (for example `?tab=keys`).
- `?mail=1` shows in the URL as `?mail=%221%22` once loaded. It works: Keys is selected and the Mail sheet opens.
- The old `?sheet=` param stays in the URL after landing (for example `?sheet=tools`). It is dropped when another tab is clicked, or when the mail sheet closes (the URL becomes `?tab=keys`).
- With the Mail sheet open, the tab bar is behind the modal, so a tab click only works after closing it.
- On the map the inspector shows an extra "Profile" link next to Close. It points to `/agents/<id>`, the same target as "Open agent room".
- On desktop, opening an archived agent without `?tab=` landed on `?tab=settings`. On phone it landed on Chat. I think the desktop result came from leftover queued tab clicks in my script, but I did not retest it.
- The Owner card appears in Settings with a single member (owner and backup selects). Fine.
- The Voice and Name textboxes contain a trailing "--name Voice" or "--name Name" because of how my CLI parsed the fill command, not an app bug.

## Flows

| Flow | Desktop | Phone |
|---|---|---|
| F1 | pass | pass |
| F2 | pass | pass |
| F3 | pass | pass |
| F4 | pass | pass |
| F5 | fail | fail |
| F6 | pass | pass |
| F7 | pass | pass |

### F1 header and default tab
Steps: open `/agents/<id>`.
- Desktop: header shows avatar "S", name, "job line · Owner: Dev User", address chip `sorter@agents...`, "Runs on Cloud" chip, Edit and Run now. Chat is selected. Seven tabs in order: Chat, Work, Files, Knows, Keys, Jobs, Settings. Tab list 912/912 wide, page scrollWidth 1280 (no overflow). desktop-1.png. Pass.
- Phone: same header stacked. Tab list scrolls inside itself (474 against 390 wide, "Settings" starts off-screen), page scrollWidth 390. phone-1.png. Pass.

### F2 chat
- Desktop: the main conversation is empty ("Nothing in this conversation yet") with a composer. The list has "Open main conversation", "New conversation" and "All conversations". Sent a message: URL stayed on `/agents/<id>`, the thread shows the message and "Working", and the run later failed (no model). desktop-2.png. Pass.
- Phone: used the fresh agent "Phone Sorter". The conversation list is stacked above the thread. Sent "Phone hello": URL stayed on `/agents/<id>`, the message shows, scrollWidth 390. phone-1b-new-agent.png (before sending) and phone-2.png (after). Pass.

### F3 tabs
Each tab click set `?tab=<name>` and showed its panel. Work is `?tab=work` (lists the recent task after a reload). Files is `?tab=files`. Knows is `?tab=knows`. Keys is `?tab=keys`. Jobs is `?tab=jobs`. Settings is `?tab=settings`.
- Files: folders `agents/sorter` (home, read and write) and `wiki` (read, suggestions), "+ Add folder", "Open home folder" opens `/library?dir=agents/sorter`.
- Knows: Instructions, Voice, Skills. Typing a voice shows a Save button. After Save and a reload the value persisted.
- Keys: Tools (Browser switch, connectors, secrets), Channels (Slack form), Works with (Hands to, Subagents, Peers), "Ask me before it…" card. Switching the ask level to "Ask before it acts outside" persisted across a reload (desktop), "Ask before everything" on phone.
- Jobs: Triggers, Routines. Create trigger opens a dialog (Name). Create routine opens a dialog (Name, Schedule, Hour, Minute, Timezone, Prompt).
- Settings: Runs on Cloud with Move agent, Computer, Owner and Backup, Edit agent form (Name, Instructions, Model, Advanced), Save changes, Archive agent. Renaming and saving updated the h1 at once.
- Screenshots (desktop-, then the same names with phone-): 3a-work, 3b-files, 3c-library, 3d-knows, 3e-voice-saved, 3f-keys, 3g-jobs-trigger (phone: also 3g-jobs), 3h-jobs-routine, 3i-settings (desktop-3g-jobs-trigger was taken with the trigger dialog open). No horizontal overflow on phone in any tab (scrollWidth 390).
- Pass at both sizes.

### F4 old links
`?sheet=tools` lands on Keys, `skills` on Knows, `handsTo` on Keys, `startsOn` on Jobs, `channels` on Keys, `edit` on Settings, and `?mail=1` on Keys with the Mail dialog open ("Mail / Sorter Pro / No mail yet"). Clicking another tab drops `sheet`. Same result at both sizes. Screenshots: desktop-4-tools, desktop-4a-mail, phone-4-skills, phone-4a-mail. Pass.

### F5 archive
Steps: Settings, Archive agent, Archive in the confirm dialog (desktop-5a-confirm, phone-5a-confirm). The app then redirects to the `/agents` list (desktop-5b-archived). Opening the agent shows the "This agent is archived" banner with Restore, an "Archived" chip, and tabs that still switch (desktop-5c-archived-page, phone-5c-archived-page, desktop-5d-archived-chat, desktop-5e-archived-keys, phone-5b-archived-settings). Settings controls are disabled and Chat is replaced by a notice, but Keys, Jobs, Files and Knows controls are not disabled (defect 1). Restore removes the banner (desktop-5f-restored, phone-5f-restored). Fail at both sizes.

### F6 keyboard
With focus on the Chat tab: ArrowRight moves to Work then Files. ArrowLeft goes back to Work. End goes to Settings. Home goes to Chat. ArrowLeft from Chat wraps to Settings. Focus moves without changing the tab. Enter on the focused tab activates it (End then Enter gave `?tab=settings`). desktop-6-keyboard.png and phone-6-keyboard.png. Pass.

### F7 map
Open `/map`, press Editor, select the agent node. The inspector shows Knows, Keys, Jobs and Settings, which link to `?tab=knows`, `keys`, `jobs` and `settings` and land on the matching selected tab. "Open agent room" goes to `/agents/<id>` (Chat). It also shows the extra "Profile" link. Screenshots: desktop-7a-map, desktop-7b-inspector, desktop-7c-settings, phone-7a-map, phone-7b-inspector, phone-7c-room. Pass at both sizes.
