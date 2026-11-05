# Task view: conversation first

Status: approved by Dom on 5 Nov 2026. Tasks TV.1 and TV.2. Mockup: `mockup.html` next to this file (open it with `?w=desktop|laptop|phone&s=done|running|failed|paused|question|mail`; its source lists the other parameters). Six review rounds ended at 9.1 (Opus) and 9.0 (Codex). The review is at https://claude.ai/artifact/2wWGwVneBKAiSFdKWTSVMx.

## Why

Dom: "The tasks view is really fundamentally broken. The chat is tucked away on the side and doesn't really have space. Some of the view, like the assistant response, is cut off."

Today `/tasks/$runId` shows the same run three ways. The Receipt column clips each step to three lines of raw text (`ExpandableText lines={3}` in `receipt.tsx`), so an answer shows as `**Bot token**` cut mid-line. The Thread, the only part that renders the answer properly, sits in the narrow right column under Computer, Files and Action log cards that are usually empty, inside a `max-h-[60dvh]` scroll box (`thread-container.tsx`). On phones a fixed Reply bar covers the cards. `docs/ux-review/review.md` item 10 already called this out as duplicate panels.

## The design in one paragraph

The conversation is the page. Under a compact header sit three tabs: Conversation, Files and Log (plus Mail for a mail task, and Computer on phones when the agent has one). Conversation is the default. It is one column, up to 780px wide, that fills the height between the tabs and a composer pinned to the bottom of the screen. The Receipt goes away as a surface. Its job, "what happened step by step", is done by the conversation itself: the user's message, reasoning, one collapsed tool group row per turn, the rendered answer, request cards and a files line. Files and Log are full-width tabs scoped to the run. The Computer opens as a docked panel beside the conversation on desktop.

## Run and session

The page shows one run. The conversation shows the whole session (thread).

- The header (title, status, agent, started by, runs on, time, cost), Stop, the Files tab and the Log tab describe the run in the URL.
- The conversation shows every run of the session in order, separated by run dividers ("Run 3 of 3 · this run · 21:56").
- Earlier runs render in full, with their tool groups and reasoning collapsed. With one or two earlier runs they are expanded. With three or more they collapse into one row ("6 earlier runs in this thread · all failed", "Show"). "all failed" or "all done" appears only when every earlier run has that status.
- When the session has more than one run, the header meta ends with a run picker, "Run N of M". It opens a menu anchored under the button and kept inside the viewport, 440px wide at most and scrolling past about seven rows. Each row has the run number, that run's own status (Running, Needs you, Done, Failed), start time and its title (`runTitleFor`). Choosing a row navigates to that run's `/tasks/$runId`. This replaces `ThreadRuns` ("Earlier/Later in this thread").
- On an older run's page, a cyan bar under the tabs says "Viewing run 1 of 3. Files and Log show this run." with "Go to the latest run". The conversation opens at that run's divider, and the run's messages carry a cyan left rule.
- A reply always continues the session. The composer label reads "Sending starts run M+1 in this thread", where M is the session's run count, not the viewed run's number. When the newest run is still working, the bottom bar reads "Run 3 is working. Reply when it is done." instead of the composer.

## Header

Desktop, in this order:

1. Breadcrumb "Desk › Task". On this page the sidebar toggle moves into this row, and the 48px bar with `SidebarTrigger` in `_app.tsx` is not shown, so the conversation gets that height.
2. Title (`task.title`, which the server already cuts at 60 characters plus "..."), wrapping to two lines at most, so the header buttons never cut it a second time. Then the status pill. Then, on the right, the Computer toggle when the agent has a computer, and Stop only while the run is active (running, queued, waiting). A finished run shows no Stop.
3. One meta line: agent (link), "Started by …" ("Started by Dom Fretz", "Started by trigger EP staging bot", "Started by mail from jane@…"), runs on, start time and duration, "$0.14 this run" (or "so far"), and the run picker.

The status pill shows "Needs you" while a request waits, and "You have control" while the person holds a takeover (the meta then reads "paused, you have control").

Phone, one rule in every state: the title on up to two lines, then one 40px row with the status pill, a meta text that truncates ("Discord Role Manager · 21:56 · $0.14", or "Trigger EP staging bot · 05:04"; with both the picker and Stop present the agent name drops first, so time and cost stay), and on the right the run picker as "3/3" and Stop, each 40px. With the keyboard open, the header shrinks to a one-line title and the row hides.

The four `Fact` chips go away.

## Tabs

`Conversation`, `Files N`, `Log N`, then `Mail N` for a mail task. On phones a `Computer` tab follows when the agent has a computer. Five tabs fit at 390px with 10px tab padding. Only when two or more would be left over does a phone show Conversation, Files, Log and the most relevant extra (Computer while a takeover waits or is held, otherwise Mail for a mail task) and put the rest under `More`. More shows how many destinations it holds and a dot when one needs the person, opens a small menu, and takes the open item's name ("Computer ▾") while one of its items is selected. Tabs never sit partly off screen.

- The Files count is folder files plus outside edits plus conflicts plus artifacts, for this run.
- The Log count is the number of action log entries for this run.
- A tab with zero items still opens and shows an empty state ("No files from run 7. The task folder is empty and nothing outside it changed.").
- The Conversation tab shows an amber dot while a request waits. The Files tab shows an amber dot when the run has a conflict, and the files line shows "1 conflict" in amber as a link to that row. The phone Computer tab shows an amber dot while a takeover waits, and no dot otherwise.
- On any other tab, a request that waits shows an amber banner under the tabs with one action: "Review approval", "Answer question" or "Take over". It is 40px tall, never wraps, and is hidden on the Computer tab while that tab already holds the takeover.
- Markup: `role="tablist"` with `<button role="tab">`, roving tabindex, `aria-controls`. Manual activation: arrows, Home and End move focus, Enter or Space opens. The selected tab can live in the search params (`?tab=files`), so a link can open it. Switching tabs keeps the composer draft and the conversation scroll position.

## Conversation

Reuse the thread components (`TaskThread`, `ThreadContainer`, assistant-ui). Changes:

- `ThreadContainer`: drop `max-h-[60dvh]`. The viewport fills the space between the tabs and the bottom bar and is the page's only scroll area. The column is centred, up to 780px.
- Member messages stay orange bubbles with the author and time above. Outside input (mail, trigger, Slack, peer) renders as a neutral card (`bg-card`, border, grey left rule) with a source label such as "Mail from jane@… · 08:12" or "Trigger: EP staging bot · 05:04". Orange is only for workspace members.
- "Edit and resend" stays on the latest member message, with "(stops the agent)" while the run is active. On phones it sits on the name line as "Edit".
- Reasoning keeps its collapsed "Reasoning" row (40px tall on phones).
- Tool calls use the existing group row (`groupLabel`, "web_fetch, write_file ×2") with "3 tool calls" on the right. The group is collapsed when the turn is over and open while it runs, with a spinner on the call in progress. An opened call shows input and output, cut at 4,000 characters with "… (truncated)" as `tool-card-logic.ts` does today.
- Markdown renders in full. A code block has a header row with its language and a Copy button (40px on phones), so Copy never covers code. A block wider than the column scrolls sideways inside itself, with a right-edge fade. Copy says "Copied" for two seconds.
- After the run's last answer, a files line: "2 files in the task folder, 1 edited outside, 1 conflict, 1 artifact · See files", built from `tasks.files` and the artifacts list, so it matches the Files count. It opens the Files tab. It is hidden when the run has no files.
- Failed runs show an error card: "Run failed" and the raw error text. When the error names a settings page (today, model providers), add a button to that page. No retry button until a retry exists.
- Request cards (`RequestCard`) sit in the conversation in time order, inside the assistant turn that asked. Approval: the action text, a preview, Approve and Deny. Question: options as radios with arrow keys, plus a text box. Nothing is selected at first (unless a draft is restored). Picking an option clears the text, typing clears the option, and "Send answer" stays disabled until one is set. Ctrl+Enter sends from the text box. Takeover: the reason, Take over and Cancel request. While the person holds control the card turns cyan, "You have control". (`DesktopStatus` has no time control was taken, so the card shows none.) Answered requests collapse to one line ("Approved by Dom Fretz at 21:49 · Post a message in #mods", "Handed back at 22:03").
- "Edit and resend" while a request waits cancels that request, and its card reads "Cancelled, you edited the message".
- All buttons in the conversation are at least 40px tall on phones and 36px on desktop.

Opening position:

- Done or failed: the current run's divider at the top of the viewport, or its first message when the session has one run. With tool calls in one row, the answer starts on the first screen at 1280 and 390.
- Running: the bottom, following new content while the reader stays at the bottom.
- Waiting: the request card, about 160px from the top.
- Older run: that run's divider.

## Bottom bar

The bottom bar is one of these, never two:

- **Composer** when a reply is possible. Label row "Reply" and "Sending starts run M+1 in this thread". The textarea, Attach, Library, dictation and Send. Ctrl+Enter or ⌘Enter by platform. A 1px top border and a 16px fade above it. On phones the icon buttons are 44px with `aria-label`s.
- **Working bar** while the run is active and not waiting: a spinner, "Working · <current tool and target>", and "Reply when it is done". When the reader has scrolled up, "Jump to latest" appears.
- **Control bar** while the person holds a takeover: cyan, "You have control. Hand back on the computer panel when you are done." ("tab" on phones).
- **Waiting bar** while a request waits: amber, "Waiting for your approval" (or answer, or takeover). "Go to the request" appears only when the card is more than half out of view, and moves focus to the card's heading. It hides while the person types into the question's text box, so Send answer is the action.
- **Routing bar** when the thread takes no replies here: "A trigger started this thread, so it takes no replies here. [Open the trigger]", or "Mail started this thread. Replies go by mail. [Open the mail thread]". On phones it is one full-width 48px button.

Every bottom strip pads for the safe area. The page uses `100dvh`, and `StickyComposer`'s keyboard inset keeps the composer above the phone keyboard. The fixed phone `ReplyBar` goes away.

## Files tab

`TaskFilesList` and the artifacts list, full width, with a scope line "Files from run 3 · library/agents/…/tasks/<runId>/". Sections, each only when it has rows: In the task folder (Open, Download), Changed outside the folder (tag "edited · v3", Open), Conflicts (tag "conflict", Compare), Artifacts (tag "artifact", Open). Rows wrap on phones, actions are 40px there. "Open the folder in the library" at the end.

## Log tab

`ActionLog` full width with a scope line "Log of run 3 · every event, oldest first". Rows keep their time, tag and text. Long text clamps to four lines with "Show all" (40px tall on phones). On phones the tag sits above the text.

## Mail tab

`MailSlot` content full width: subject, one row per message with its status chip, "Open the mail thread".

## Computer

The panel's status line is `controllerLabel()` and `notLiveText()` from `desktop-status.ts` as they are today ("Connecting…", "You are in control", "The agent is in control", "Another person is in control", "Nobody is in control", "Computer offline"). The dot is cyan while you are in control, amber while a takeover waits, and grey otherwise. It never infers the machine's state from the viewed run. The "You have control" panel uses the cyan border and fill of the rest of that state; Hand back stays the orange primary button.

Links to `#computer` (the Slack cards use them) open the dock on desktop or the Computer tab on phones, scroll the controls into view and move focus to the panel heading.

Desktop: the header's Computer toggle opens a docked panel on the right of the conversation. The panel takes the width left after a 560px minimum for the conversation, between 360px and 560px (400px at 1280, 560px at 1440). It has a close button, and Escape closes it and returns focus to the toggle. Links to `#computer` open it.

- No request: the live screen, "A live view of the computer as it is now, not a recording of this run. You can take over when the agent asks.", Full screen.
- Asked (a takeover request waits): the screen and "Waiting for you to take over. The request and its Take over button are in the conversation." Take over lives once, on the request card.
- Mine (the person holds control): the screen, "You have control. The agent waits until you hand back.", an optional note, Hand back, Full screen. The pill says "You have control", the rail shows a "You have control" item instead of the Needs you request, and the bottom bar is the control bar. Stop stays in the header. Hand back shows "Handing back…" while it runs. On success the request card collapses to "Handed back at 22:03". On failure the person keeps control and a toast says why.

Phone: the same content in the Computer tab, with Take over, Cancel request and Full screen on the tab itself in the asked state. Take over opens the screen full size, best turned sideways.

`DesktopScreen` and the takeover controls in `slots.tsx` already supply all of this.

## Keyboard

- Tabs: arrow keys, Home, End, roving tabindex.
- Run picker and the phone More menu: Enter or Space opens, arrows move, Enter chooses, Escape closes and returns focus.
- "Go to the request" moves focus to the request card's heading.
- Computer panel: Escape closes and returns focus to the toggle.
- Composer and the question text box: Ctrl+Enter (⌘Enter on Mac) sends.
- Visible focus on every control, using the app's cyan focus ring.

## Components

- `components/task/task-page.tsx`: new layout. Header, tabs, the conversation area and the bottom bar. Drop the two-column flex and the slot stack. Keep the live state, the stream and the reducers as they are.
- `routes/_app.tsx`: let the task route render full height, without the outlet padding, the 48px trigger bar and `Footer`. A route flag or a layout variant is enough.
- `components/task/receipt.tsx`: no longer rendered. `buildReceipt` can stay in the service for the desk's "How it got here" and any later use.
- `components/thread/thread-container.tsx`: remove `max-h-[60dvh]`, fill the parent, centre to 780px.
- `components/thread/task-thread.tsx` and `composer-container.tsx`: the bottom bar states above, the run number label, outside-input cards, the files line after the last answer.
- `components/thread/tool-call-container.tsx`: the group row gets the "N tool calls" count and opens while running.
- `components/thread/reply-bar.tsx`: delete.
- `components/task/thread-runs.tsx`: replace with the run picker menu (same data, `task.otherRuns`).
- `components/task/slots.tsx`: `SlotCard` goes. `ComputerSlot` becomes the docked panel and the phone tab. `FilesSlot`'s polling moves to the Files tab and the files line.
- `components/task/task-files.tsx`, `action-log.tsx`, `mail-slot.tsx`, `ArtifactsSlot`: render inside their tabs, full width.
- `components/task/task-logic.ts`: the pill gains "You have control". `Fact` goes.

## Not in this change

- A retry button on failed runs.
- A summary line written by the agent at the top of a run.
- Any change to what the session stream sends.

## Decisions (Dom, 5 Nov 2026)

1. Tabs, not a side column.
2. The Receipt is dropped from the page. `buildReceipt` stays in the service for the desk's "How it got here".
3. Take over lives on the request card only, on desktop too. The Computer panel shows status, and Hand back while you hold control.
4. Full height applies to the task page only, for now. The 48px sidebar-toggle bar and the footer stay on every other page.
5. On phones, Stop also appears in the working bar, near the thumb, as well as in the header row.
