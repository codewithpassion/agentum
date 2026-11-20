---
id: SL.5
title: "Slack link on a real workspace"
milestone: SL
size: M
status: in_progress
depends_on: [SL.3, SL.4]
branch: task/SL.5-slack-link-e2e
lane: e2e
executor: claude
---

From `docs/v4/build-plan.md`, milestone SL. End-to-end check for SL. It needs a real Slack workspace.

## Scope

- Local: run the full flow against the fake gateway, both directions, with three member apps.
- Staging: steps for Dom to link a test channel with two real agent apps, post from Slack and from Agentum, answer an approval card in Slack. Write the steps and the expected result to `docs/reviews/SL-e2e.md`.

## Check

- The local flow passes. The staging steps are written and marked as waiting on Dom.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: from SL.2: in a linked channel a Slack guest is stored as a user post with author id slack:<teamId>:<userId>, and linked-channel messages no longer go into slack_messages. Check that slack_history and slack_search still find linked-channel messages, and check guest posts render well.
- 2026-11-21: dispatched on task/SL.5-slack-link-e2e (v4 controller session).
