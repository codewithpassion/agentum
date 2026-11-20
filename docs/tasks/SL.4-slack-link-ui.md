---
id: SL.4
title: "Link a Slack channel on the team page"
milestone: SL
size: S
status: done
depends_on: [SL.1, TM.6]
branch: task/SL.4-slack-link-ui
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
- 2026-11-21: dispatched on task/SL.4-slack-link-ui (v4 controller session).
- 2026-11-21: merged as 812f68b3, review clean after 0 fix rounds. Browser proof passed at both sizes against stubbed Slack: docs/reviews/tasks/SL.4/browser.md. check, test and build passed on main. Dom: live steps in docs/reviews/tasks/SL.4.md.
