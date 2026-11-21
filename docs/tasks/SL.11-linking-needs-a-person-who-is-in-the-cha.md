---
id: SL.11
title: "Linking needs a person who is in the channel"
milestone: SL
size: S
status: done
depends_on: []
branch: task/SL.11-linking-needs-a-person-who-is-in-the-cha
lane: services-teams
executor: claude
---

From the SL gate review, round 1 (`docs/reviews/SL-1.md`, must-fix 2).

## Scope

- `teams.slack.channels` lists only the channels the requesting person is in on Slack: their Slack identity link in that Slack team, checked with `conversations.members` or `users.conversations` through the vouching app. An admin may see all.
- `teams.slack.link` refuses unless the person is linked to Slack and is a member of the channel. An admin skips this check. The error says what to do.
- A private channel's messages land in a room that every workspace member can read. The default is that only an admin may link a private channel, and the team page says so. List it as an assumption Dom can change.
- `topicRootTs` filters by the team's current Slack team and channel (nit 5).
- Note for the TM owner: `teams.addMember` adds any active agent without its owner's consent. That is the root of this finding and sits outside SL. File it as its own task if Dom agrees.

## Check

- `teams.test.ts`: a member who owns the team but is not in the channel on Slack cannot list it or link it. A person who is in it can. A private channel follows Dom's rule.
- A flow test: after a relink to a second channel, a post in an old topic opens a new thread in the new channel. It carries no `thread_ts` from the old one.
- `bun run check && bun run test && bun run build` pass.

## Controller decisions

- Only an admin may link a private channel, and the team page says so.
- `teams.addMember` adding an agent without its owner's consent is out of scope here; it is recorded in SL-1.md for a later TM decision.

## Log
- 2026-11-21: added by controller.
- 2026-11-21: dispatched.
- 2026-11-21: review clean with no fix rounds. Browser proof failed on the non-admin path (the verifier only signed in as admin). Sent back to sign in as the existing plain member with agent-login, as KY.10 did. Private channels are admin-only, as the controller decided.
- 2026-11-21: browser re-run as the plain member passed at both sizes, admin path too. Ready at 2e23a52a.
- 2026-11-21: merge conflict with SL.12 in slack-room-flow.test.ts. Sent back to merge main.
- 2026-11-21: merged origin/main, resolution reviewed clean. Ready at 1bf02377.
- 2026-11-21: merged 9357ef6f, merge check passed. Done.
