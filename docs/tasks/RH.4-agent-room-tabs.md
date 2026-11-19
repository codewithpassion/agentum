---
id: RH.4
title: "Agent room: one page with seven tabs"
milestone: RH
size: L
status: in_progress
depends_on: [NV.2]
branch: task/RH.4-agent-room-tabs
lane: web-agent
executor: claude
---

From `docs/v4/build-plan.md`, milestone RH. The profile holds nine rows, five cards and six sheets. It becomes a header and seven tabs: Chat, Work, Files, Knows, Keys, Jobs, Settings. This task builds the frame and moves existing content into tabs. Later tasks replace a tab's content inside its own folder.

## Scope

- `routes/_app/agents.$agentId.tsx` renders a header (avatar, name, job line, owner, address chip, where it runs) and a tab bar driven by `?tab=`. Default tab is Chat.
- One folder per tab under `components/agent/room/<tab>/` with an `index.tsx` entry. No tab imports from another tab's folder.
- Chat: the caller's main conversation with this agent (`sessions.main`), using the thread components from `/threads/$sessionId`, plus the conversation list from `threads-card.tsx` on the left.
- Work: `recent-tasks-card.tsx`. Files: `library-row.tsx` and a link to the home folder. Knows: `voice-field.tsx` and the skills sheet content. Keys: the tools sheet, channels sheet, `works-with.tsx` and `ask-before-card.tsx`. Jobs: the startsOn sheet content. Settings: `agent-form.tsx`, `runs-on-card.tsx`, computer card, archive.
- Old links keep working: `?sheet=tools` opens Keys, `skills` Knows, `handsTo` Keys, `startsOn` Jobs, `channels` Keys, `edit` Settings, `?mail=` Keys.
- Delete `profile-rows.tsx`, `manage-sheet.tsx` and `sheet-ids.ts` once nothing imports them.

## Check

- Tests for the `?sheet=` to `?tab=` mapping and for each tab rendering with a fixture agent.
- Browser: every control that worked on the old profile works in its tab, on desktop and phone width.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/RH.4-agent-room-tabs (v4 controller session).
