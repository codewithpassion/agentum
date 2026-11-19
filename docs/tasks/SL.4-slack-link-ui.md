---
id: SL.4
title: "Link a Slack channel on the team page"
milestone: SL
size: S
status: todo
depends_on: [SL.1, TM.6]
branch: null
lane: web-team
executor: claude
---

From `docs/v4/build-plan.md`, milestone SL. The owner links one channel to the team room.

## Scope

- On `/teams/$teamId`: a Slack section with a channel picker (channels the lead's app can see), Link and Unlink.
- After linking, list member agents whose app is not in the channel, each with the `/invite @name` line to paste in Slack.
- Show the link on the room header with the channel name.

## Check

- Component test for the missing-apps list. Browser with the fake gateway.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
