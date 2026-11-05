---
id: TV.1
title: Task view layout, conversation first
milestone: TV
size: L
status: in_progress
depends_on: []
branch: TV.1-task-view
lane: web
executor: codex
---

Spec: `docs/ux-review/task-view/spec.md` (with its Decisions), mockup `docs/ux-review/task-view/mockup.html`.

## Scope
- The task route renders full height, without the outlet padding, the 48px trigger bar and the footer. That applies to this route only (decision 4).
- The new header, the tabs (Conversation, Files, Log, Mail for mail tasks, Computer on phones) with the request banner on the other tabs, the conversation column up to 780px wide, filling the height.
- The Files, Log and Mail tabs show this run, full width.
- The run picker replaces "Earlier/Later in this thread". Earlier runs fold into one row when there are three or more. Viewing an older run shows the "Viewing run N of M" bar.
- Remove the Receipt, the side slot stack, `SlotCard`, the fixed phone Reply bar, and `max-h-[60dvh]` on the thread. `buildReceipt` stays in the service.
- The Stop button is hidden on runs that aren't active. Today it looks enabled on a Done task.
- The bottom bar, outside-input cards, tool group, Computer dock and keyboard work are TV.2. Leave the existing composer working in the new layout.

## Check
- Tests for the route layout flag, the tabs and their keyboard, the run picker, the request banner, Stop visibility, and that the answer is no longer clipped (no line clamp on assistant text).
- `bun run check && bun run test && bun run build`, then the bundle grep for `drizzle` in `apps/web/dist/client`.
- Screenshots of a dev build (dev login, with a task that has a long answer) at 1440x900, 1280x900 and 390x844, next to the mockup's matching frames, saved in the log folder.

## Log
