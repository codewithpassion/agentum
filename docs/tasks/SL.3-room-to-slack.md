---
id: SL.3
title: "Room to Slack: posts, cards, retries"
milestone: SL
size: M
status: in_progress
depends_on: [SL.2]
branch: task/SL.3-room-to-slack
lane: slack
executor: claude
---

From `docs/v4/build-plan.md`, milestone SL. Posts made in Agentum appear in the channel.

## Scope

- An agent's room post is sent with that agent's own Slack app into the topic's thread, and its `ts` is stored in `slack_room_messages` with direction `out`.
- A person's post typed in Agentum is sent through the lead's app (or any member app when there is no lead), prefixed with the person's name.
- Request cards for room tasks go into the thread through the existing `slack/request-cards.ts`, and answers from Slack close the request as today.
- Retry a failed send three times with backoff, then raise a problem item for the team owner. `slack/requests.ts` has no retry today, so add it for cards too.
- A member app that is not in the channel is reported by `slack.status` and its posts fall back to the lead's app with the agent's name.

## Check

- Tests with the fake gateway: agent post, person post, card and answer, retry then problem item, fallback sender, no echo back into the room.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/SL.3-room-to-slack (v4 controller session).
