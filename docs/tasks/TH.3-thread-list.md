---
id: TH.3
title: One conversation list, and a main thread per agent
milestone: TH
size: M
status: in_progress
depends_on: [TH.1]
branch: task/TH.3-thread-list
lane: web
executor: claude
---

From the 10 Nov 2026 review. No place lists past conversations per agent, and "New task" always opens a new session. The assistant panel already has a good list (`apps/web/src/components/assistant/assistant-conversation.tsx`).

## Scope

- Lift the assistant's conversation list into a shared component (items, active id, select, new), with a timestamp per row. The assistant panel uses it.
- A history view lists the caller's threads by last activity, with paging, search and an agent filter. Assistant conversations appear in the same list, each row marked with its kind (Dom, 10 Nov 2026), and open in the panel.
- An agent's rail row and its page open the main thread. The agent page lists that agent's threads. "New conversation" sits beside the current one.
- "All tasks" and "View all N running" go to this list with the right filter.
- Add a limit of 50 and paging to the assistant's own list and message reads.

## Check

- Component tests for the shared list in both uses.
- On staging: reach yesterday's conversation with an agent in two clicks from the rail.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-10: added from the 10 Nov review, after Dom's decisions (members are trusted with credentials, the assistant may approve skills, assistant conversations share the thread list and are marked).
- 2026-11-10: dispatched to a Sonnet implementer on task/TH.3-thread-list. Lane rule relaxed for this run (Dom asked for about six in parallel); files checked against the other running tasks. Runs beside TH.2.
