---
id: SL.2
title: "Slack to room: one post per message"
milestone: SL
size: M
status: done
depends_on: [SL.1, TM.3]
branch: task/SL.2-slack-to-room
lane: slack
executor: claude
---

From `docs/v4/build-plan.md`, milestone SL. Every member app receives every message in a channel it sits in. The room must record each message once. Files: `packages/services/src/slack/*`, `apps/web/src/server/routes/slack.ts`.

## Scope

- For an event in a linked channel: insert `slack_room_messages` first with its unique key, and only the insert that wins creates the room post. The other apps' copies of the event are dropped.
- A Slack thread maps to a topic by `thread_ts`. A top-level message opens a topic titled from its first line.
- The author maps to a person through `identity_links`. An unknown Slack user posts as a named guest who cannot wake agents.
- A mention of a member agent's app wakes that agent through the room path from TM.3, not the per-agent Slack session path. A message with no mention follows `lead_listens`.
- Messages from member apps (`bot_id` of a team member) are ignored here, because SL.3 already recorded them when it sent them.
- A channel with no link behaves exactly as today.

## Check

- `slack-events.test.ts`: four apps, one post. Thread mapping, unknown user, mention routing, no-mention routing, bot echo ignored, unlinked channel unchanged.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/SL.2-slack-to-room (v4 controller session).
- 2026-11-20: merged as 2a12a55c, review clean after 0 fix rounds. Tested against stubbed Slack only. check, test and build passed on main. Dom: live Slack steps in docs/reviews/tasks/SL.2.md.
