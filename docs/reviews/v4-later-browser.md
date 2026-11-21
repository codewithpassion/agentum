# V4 later tasks, browser pass

Branch `task/V4-later-browser`, on main at 74230a53 (TX.10, TM.15 and TM.16 merged). Local `vite dev` on port 3417, signed in with the dev login as the owner of the seeded Launch team (three fake-runtime agents). Sizes: 1280x800 and 390x844. Screenshots are in `docs/reviews/v4-later-browser/`.

## Verdicts

| Flow | 1280x800 | 390x844 |
|---|---|---|
| TX.10 Team memory section | pass (Undo not reachable, see below) | pass (same limit) |
| TM.15 Dictation button in the room composer | pass | pass |
| TM.16 Phone room layout | not asked | pass |

No must-fix bug found.

## TX.10 Team memory on the team page

Steps (desktop): opened `/teams/<id>`, found the "Team memory" section under Team rules, with the line "Only the team's owner or an admin sees this."

- Fresh team, Dream now: the card changed from "Launch has not dreamed yet" to "Today's dream: Nothing happened since the last team dream." No error. The run is the "skipped" kind, as the service has nothing to read.
- After posting in the room and seeding two conflicting work notes on Ada and Cy (Knows tab, Shares with team on), Dream now again: diary "Read the shared notes of Ada, Cy and Di. Nothing needed changing.", counts line "Nothing changed.", and a "See changes" button that opens to "This dream changed no notes." A later press with nothing new reads "Nothing happened since the last team dream." again.
- Team notes: wrote `teams/launch/memory/work.md` through `library.write` (the library allows a hand edit). The section then listed a "Work in progress" group with two notes and their dates, read only. A team with no notes shows "The team has no shared notes yet. A team dream lifts what three members hold into team memory."
- Undo: not shown, and could not be exercised. The dev build answers team dreams from `dream/scripted-model.ts`, whose team calls always return no conflicts, no shared notes and no friction (`scripted-model.ts` lines 114 to 122). A local team dream therefore never changes anything, so there is nothing to undo. No model key was used. Undo needs a real model run with changes, or a seeded `memory_changes` row.
- Phone: same section stacks in one column, the dream card and note list fit with no horizontal scroll (document scrollWidth 390).

Screenshots: `tx10-desktop-before.png` (never dreamed), `tx10-desktop.png` (after See changes, with notes), `tx10-phone.png`.

## TM.15 Dictation in the room composer

- Both sizes: the room composer shows "Start dictation" and "Choose microphone" next to Send.
- As served (no OpenRouter key saved): both buttons are disabled, same as the agent chat and the Knows voice box. The accessible name stays "Start dictation". The component's title says "Add an OpenRouter key in Settings, Model providers." Clicking does nothing.
- With `dictation.status` stubbed to `available: true` (page `fetch` patched, composer remounted by moving to a new topic): the buttons enable. Clicking Start dictation in headless Chromium showed no permission prompt. It ended in an alert under the composer, "Nothing could be transcribed. Please try again." At both sizes. No crash, no console error. A real microphone prompt and transcript were not checked, since headless has no microphone and there is no key.
- The review nit about dictated text and an "@" was not testable without audio.

Screenshots: `tm15-desktop.png` (disabled as served), `tm15-desktop-clicked.png` (stubbed, after click), `tm15-phone.png` (focused, with the dictation buttons), `tm15-phone-clicked.png`, `tm15-phone-before.png`.

## TM.16 Phone room layout (390x844)

- Composer one line until tapped: the sticky composer is 63px tall with a 42px textarea (was about 200px). The label, hint, Send and dictation row show only after the textarea is focused, and collapse on blur. The collapsed box has no visible label or placeholder (the review nit).
- Last task chip visible: posted four messages in one topic so the thread scrolls (page height 2216px). Scrolled to the bottom with the composer collapsed: the last Task chip sits at y 600 to 640, the composer starts at y 664. Nothing is hidden.
- Topics sheet: opened Topics, New topic, typed a title, Create topic. The dialog and the sheet both closed at once and the new topic opened ("Phone topic"). No tap on a topic was needed.

Screenshots: `tm16-phone-collapsed.png`, `tm16-phone.png` (scrolled to the last chip), `tm16-phone-sheet-open.png`, `tm16-phone-after-create.png`.

## Console and network

- No page errors (`errors` empty) in any flow.
- One console error on the team page at both sizes: `Failed to load resource: 400`. The request is `teams.slack.channels`, "Slack would not list the channels (invalid_auth)." It shows on the team page's Slack section in red. The fake Slack was not started and the seeded apps have no live workspace, so this is the local setup, not TX.10. It is not on the room page.
- Other console lines: Vite connect, React devtools hint, Clerk development keys warning.
- No other failed requests seen. No favicon check made.

## Setup notes

- The seed script needs a workspace first. Signed in once, then `bun run add-workspace --org <id> --name "Dev Workspace" --local` with the dev user's Clerk org, then `bun scripts/dev/seed-slack-room.ts --clerk-user <id>`.
- `agent-browser` needed `AGENT_BROWSER_EXECUTABLE_PATH` pointing at the installed `chromium_headless_shell-1248`, because it looked for revision 1200.
- The Team memory section sits above the Lead and Slack sections on the team page, so a phone user scrolls past Members and Team rules to reach it.
