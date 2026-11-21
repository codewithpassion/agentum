# SL.11 review: linking needs a person who is in the channel

## Verdict per round

Round 1, commit d3382608: clean. No must-fix. The reviewer judged the `users.conversations?user=` approach sound against Slack's real behaviour.

## What changed

- `teams.slack.channels` for a non-admin lists the channels the person is in on Slack and the lead's app can see, public only. The person must have a Slack identity link in that Slack team, or the call fails with an error that says to mention one of the team's agents in Slack.
- `teams.slack.link` for a non-admin checks the same link and that the channel is in the person's list. A private channel is refused. An admin skips all of it.
- The team page says: "Only an admin can link a private channel, because its messages would land in a room every workspace member can read."
- `topicRootTs` filters by the team's current Slack team and channel. A flow test relinks to a second channel and checks the old topic opens a new thread with no `thread_ts`.
- The dev fake Slack has two more channels (one Dev Person is not in, one private) for local walkthroughs.

## Nits left

- `listChannels(userId)` follows at most 5 pages of 200. A person in very many public channels of a large workspace could get a false "Slack does not show you in that channel". Raise the cap if it happens.
- The fake's `users.conversations?user=` still requires the bot in the channel; real Slack returns the person's public channels the bot is not in. `canPost` stops those at link time.
- `slackUserOf` takes one row when a person has two Slack links in the same Slack team; it picks one without an order.
- `personChannels` has no unit test for its app fallback or its failure message; the flow test reaches it.
- An admin who sees no channels gets the non-admin hint in the empty-state text.
- The new dev channels keep the `sl5-` prefix.

## Ideas beyond the scope

- `teams.addMember` adds any active agent without its owner's consent. This is the root of the finding SL.11 closes at the Slack edge. It is recorded in SL-1.md for a TM decision.

## Browser proof

`docs/reviews/tasks/SL.11/browser.md`. Round 1 (admin) passes at 1280x800 and 390x844. Round 2 signs in as the plain `org:member` dev+member user and passes at both sizes: the picker lists only #sl5-room, the private-channel sentence shows, linking a channel the member is not in and a private channel are refused, and a member with no Slack link sees the "not linked" message. The only console errors are those deliberate 400 refusals.

## Steps for Dom

- Decide whether the private-channel rule (admin only) stays. It is an assumption: a private channel's messages land in a room every workspace member can read.
