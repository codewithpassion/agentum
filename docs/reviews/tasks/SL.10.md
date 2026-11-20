# SL.10 review

## Verdicts

- Round 1 (93cf899b): clean. No must-fix.

## Nits left

- `packages/services/src/slack/room.ts` `isTeamApp` loads every member app of the team and filters in code. One query by app id would do. It runs once per delivered copy, so the cost is small.
- The member-app route test does not assert that `slack_messages` stays empty or that no other agent got a run.
- `deliverAs` sends only `type: "message"`. A signed `app_mention` from an outside app takes the same path and has no test.
- The leftover risk is recorded in the module header and in the task file's controller decision. The task file itself is the controller's, so it was not edited.

## Ideas beyond the scope

- Read the message back with `conversations.history` before a person's post wakes anyone. That closes the case where the owner of a member agent signs an event naming any Slack user. Dom declined it for now.

## Steps for Dom

None.
