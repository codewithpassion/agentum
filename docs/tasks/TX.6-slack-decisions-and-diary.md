---
id: TX.6
title: "Decision queue and team diary in Slack"
milestone: TX
size: S
status: done
depends_on: [TX.4, TX.2, SL.3]
branch: task/TX.6-slack-decisions-and-diary
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
- 2026-11-21: from TX.4: until this task ships, a decision queue raised in a Slack-linked workspace logs "Slack request card failed".
- 2026-11-21: dispatched.
- 2026-11-21: ready at 47482a5a after two fix rounds, review clean. The diary now posts at 08:00 workspace time for every team. Queued for merge.
- 2026-11-21: merged 1e7fce33, batch merge check with TX.6 and DR.11 passed. Done.
