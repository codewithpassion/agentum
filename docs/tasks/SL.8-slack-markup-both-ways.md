---
id: SL.8
title: "Slack markup both ways"
milestone: SL
size: S
status: ready
depends_on: [SL.7]
branch: task/SL.8-slack-markup-both-ways
lane: slack
executor: claude
---

Proposed by the Slack walkthrough (`docs/reviews/SL-e2e.md`).

Finding. Room text keeps raw Slack markup (`<@U123>`, `<#C123|name>`, `<https://x|label>`). Agentum text goes out as written, so `@name` is plain text and markdown is not mrkdwn.

Scope. Convert Slack user, channel and link markup to readable text on the way in, and `@slug` and markdown to Slack mentions and mrkdwn on the way out.

Check. Unit tests for both converters. Browser with the fake: a message with a mention and a link reads cleanly in the room, and an `@ada` in a person's post goes out as a real mention.
## Log
- 2026-11-21: added by controller.
- 2026-11-21: dispatched.
- 2026-11-21: ready at 4849ee65, review clean after 1 fix round. Browser step skipped under the new rule.
