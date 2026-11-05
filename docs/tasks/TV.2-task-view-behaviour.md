---
id: TV.2
title: Task view bottom bar, messages, Computer and keyboard
milestone: TV
size: L
status: todo
depends_on: [TV.1]
branch: TV.1-task-view
lane: web
executor: codex
---

Spec: `docs/ux-review/task-view/spec.md` (Conversation, Bottom bar, Computer, Keyboard, Decisions 3 and 5), mockup `docs/ux-review/task-view/mockup.html`.

## Scope
- The bottom bar is always one thing:
  - the composer, with "Sending starts run N in this thread", when you can reply;
  - the working bar while the agent runs. On phones it carries Stop as well (decision 5);
  - the amber waiting bar with "Go to the request";
  - the cyan "you have control" bar;
  - the routing bar for trigger and mail threads.
- Delete `reply-bar.tsx`.
- Outside input (mail, trigger) shows as neutral cards with a source label. Orange stays for the team's own messages. A failed run shows the raw error and a button to Model providers. The files line follows the last answer.
- The tool group row shows "N tool calls" and opens while running.
- Computer: docked on desktop. The conversation keeps at least 560px and the panel is 360 to 560px. On phones it's a tab. The status line comes from `controllerLabel()` and `notLiveText()`. Take over appears only on the request card (decision 3). The "you have control" state agrees across the pill, rail, panel and bar. `#computer` links open it.
- The keyboard behaviour from the spec's Keyboard section.

## Check
- Tests for each bottom bar state, the outside-input cards, the failed state, the tool group count, the Computer dock widths and phone tab, takeover consistency, `#computer` links, and the keyboard paths.
- `bun run check && bun run test && bun run build`, then the bundle grep for `drizzle` in `apps/web/dist/client`.
- Screenshots of a dev build at 1280x900 and 390x844 for running, done, failed, waiting and computer states where the dev data allows, saved in the log folder.

## Log
