---
id: SL.15
title: "The per-agent path links only its own Slack team's users"
milestone: SL
size: S
status: in_progress
depends_on: []
branch: null
lane: slack
executor: claude
---

From the SL gate review, round 2 (`docs/reviews/SL-2.md`, must-fix 1, written there as SL.14). A user from another organisation in a Slack Connect channel can still be linked by email through the per-agent path (`meetUnlinkedSender` in `slack.ts`), after one mention or DM outside the linked channel. The room then trusts that link, which undoes part of what SL.13 promised.

## Scope

- In `slack.ts` `meetUnlinkedSender`, call `matchByEmail` with `ownTeamOnly: true`, as the room path does. A user of another Slack team (Slack Connect) is not linked. They get the same reply the room gives such a user: none. Leave the `slack.unlinked_sender` event in place.
- Leave existing `identity_links` rows alone. Write in the task file that a link written earlier for an outside user stays until someone deletes it, and that Dom can ask for a one-off cleanup. Such links exist only if an outside user mentioned an app before this fix.
- Two side effects, listed as assumptions Dom can change. A failed `users.info` call on the per-agent path now gets silence instead of the hidden-email reply. An Enterprise Grid member of a sibling workspace, whose `team_id` differs from the app's, can no longer be linked at all, because the email match is the only way to link.
- Correct the comment on `matchByEmail` that describes `ownTeamOnly` as optional behaviour, so it says both paths use it.

## Check

- `slack-events.test.ts`: a user whose `users.info` `team_id` is another Slack team, with an email that matches an org member, mentions a member app in an unlinked channel. No `identity_links` row appears and no run starts. The same user then posts in the linked channel. The post is a guest post and wakes nobody.
- The existing DM and mention tests for users of the app's own Slack team still link them by email.
- Run only `bun run check` and the changed packages' tests and build (`bunx turbo run test build --only --filter="[origin/main...HEAD]"`), not the full `bun run test`.

## Log
- 2026-11-21: added by controller from the SL gate review, round 2. Side effects accepted, see the review's controller decisions.
- 2026-11-21: dispatched.
