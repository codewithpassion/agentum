---
id: TX.6
title: "Decision queue and team diary in Slack"
milestone: TX
size: S
status: todo
depends_on: [TX.4, TX.2, SL.3]
branch: null
lane: slack
executor: claude
---

From `docs/v4/build-plan.md`, milestone TX. The Slack side of the two team extras.

## Scope

- A `decisions` request posts one message with a button row per question, built in `slack/request-cards.ts`. A click answers that question and updates the message.
- The team diary from TX.2 posts in the linked channel as the lead, at 08:00 in the workspace timezone, not at dream time.

## Check

- Tests with the fake gateway: per-question answers, message update, diary timing.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
