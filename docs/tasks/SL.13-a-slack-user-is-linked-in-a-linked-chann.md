---
id: SL.13
title: "A Slack user is linked in a linked channel too"
milestone: SL
size: S
status: ready
depends_on: [SL.10]
branch: task/SL.13-a-slack-user-is-linked-in-a-linked-chann
lane: slack
executor: claude
---

From the SL gate review, round 1 (`docs/reviews/SL-1.md`, must-fix 4).

## Scope

- In `slack/room.ts` `author`, when the Slack user has no identity link, run the same match as `meetUnlinkedSender`: Slack email, then a Clerk user with that verified address, then org membership. When it matches, write the link and post as that person, if they are in the team. Run it only for users of the app's own Slack team. Skip a Slack Connect user from another organisation, whose email that organisation controls.
- Every member app hears the message and runs `author`, so the lookup runs once per copy. The link insert already uses `onConflictDoNothing`, so that is safe. Only the copy that wins the post write sends a reply, from its `after` job.
- When there is no match, the post stays a guest post. The guest gets one ephemeral reply in the thread saying how to get linked. Send it once per person, remembered through the existing `slack.unlinked_sender` event, so no schema change is needed.
- Fix `docs/reviews/SL-e2e.md` "Before you start" and step 3 so they match what the code does.

## Check

- `slack-events.test.ts`: with the directory returning a matching org member, the first message from an unlinked team member posts as that person, writes the identity link and wakes the lead. A non-member with no match gets one ephemeral reply and stays a guest. An external Slack Connect user is not linked by email.
- The SL.5 flow test passes with the seeded identity link removed from at least one case.
- `bun run check && bun run test && bun run build` pass.
## Log
- 2026-11-21: added by controller.
- 2026-11-21: dispatched.
- 2026-11-21: dispatcher stopped at the account monthly spend limit (HTTP 429). Work is saved in its worktree. Resume the same dispatcher after the limit resets on Nov 25.
- 2026-11-21: spend limit reset, same dispatcher resumed.
- 2026-11-21: ready at e86ee3d7, review clean after 1 fix round. No UI in scope.
