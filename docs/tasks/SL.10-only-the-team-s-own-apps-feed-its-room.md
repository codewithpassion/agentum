---
id: SL.10
title: "Only the team's own apps feed its room"
milestone: SL
size: S
status: in_progress
depends_on: []
branch: task/SL.10-only-the-team-s-own-apps-feed-its-room
lane: slack
executor: claude
---

From the SL gate review, round 1 (`docs/reviews/SL-1.md`, must-fix 1).

## Scope

- In `slack/room.ts` `receive`, after `findRoomLink`, drop the copy (answer `accepted`, write nothing, wake nobody) unless the delivering app belongs to an active agent that is a member or the lead of the linked team. Use the same membership rule as `memberSenderApps`.
- A dropped copy must not fall through to the old per-agent path. A linked channel never feeds `slack_messages` or a per-agent run.
- Write down in the module header what is left. An owner of a member agent still holds a signing secret that can sign an event naming any Slack user. The default is to accept that, as the per-agent path already does, and list it as an assumption in the task file. Dom can ask for a check against Slack instead, such as reading the message back with `conversations.history` before a person's post wakes anyone.

## Check

- A route test signs an event with the secret of an installed app whose agent is not on the team, names a linked person in the linked channel, and asserts no post, no `slack_room_messages` row and no run.
- The same event from a member app still records one post and wakes the lead.
- The SL.5 flow test and `bun run check && bun run test && bun run build` pass.

## Controller decisions

- Accepted: an owner of a member agent can still sign an event naming any Slack user, as on the per-agent path. Recorded as an assumption, no read-back check.

## Log
- 2026-11-21: added by controller.
- 2026-11-21: dispatched.
