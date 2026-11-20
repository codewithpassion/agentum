# SL gate review, round 1

Range: `git diff sl-start..2ba098996efa72a777e529e99769a8b217e665d3`. The range holds 648 commits from several milestones that ran in parallel. I reviewed the SL commits c5a36669, 6817bff7, f0d4ab7a, f1694564, df613d18, 3f37bff9 and 5c2d6e45 with their merges, and the Slack files as they stand at 2ba09899. `git log sl-start..HEAD` on the Slack lane (`packages/services/src/slack`, `slack.ts`, `routes/slack.ts`) shows two non-SL commits. SP.3 changes the per-agent batch path in `slack.ts`, not the room path. TX.1 adds the decision-queue throw in `requests.ts` `cardOf`, so a decision queue never gets a Slack card, in a room or anywhere else. That belongs to TX.

I judged it against the SL section of `docs/v4/build-plan.md`, the task files `docs/tasks/SL.1` to `SL.5`, `CLAUDE.md` in the checkout, "Rules that are easy to break" in `docs/HANDOVER.md`, `docs/reviews/SL-e2e.md` and the per-task reviews in `docs/reviews/tasks/SL.*`.

I ran the Slack and teams service tests (535 pass) and the web Slack tests, including `slack-room-flow.test.ts` (83 pass). Logs: `services-slack-tests.log` and `web-slack-tests.log` in this folder. I also wrote probe tests on the SL.5 harness. They live outside the repo in `probe/probe.test.ts`, and `PROBE n` below names the case. The probe's `node_modules` symlink points into the review worktree, so it dangles once the worktree is removed. To rerun a probe, re-create the worktree, run `bun install` and point the symlink at its `apps/web/node_modules`.

## Verdict

Not clean. Four must-fix findings.

Three of them are about who can put words into a team room or a Slack channel. Any agent owner whose app is installed in the same Slack workspace as a link can forge a Slack message as any linked person into that room. Any workspace member can link a channel through another owner's agent, and the whole workspace can then read it. "Always allow" on a channel card changes an agent's ask-before rules without the owner check. That gap predates SL, and SL puts the button in front of every linked member. The fourth is something only a live workspace shows: in a linked channel a Slack user is never linked to their account, so a team member who has not linked before posts as a guest. The staging walkthrough fails at step 3 for that person.

## Findings

| # | Severity | Finding | Area | Resolution |
|---|---|---|---|---|
| 1 | must-fix | The room accepts a linked-channel event from any installed app in the Agentum workspace, including an app whose agent is not on the team and is not in the channel. The app only needs to be installed in the same Slack workspace as the link. Its owner holds its signing secret, so they can sign an event that names any Slack user. PROBE 4: an app owned by a non-member signed a `message` naming Dom in the linked channel. The room recorded a post by `user_dom` and woke the lead on Dom's behalf (`onBehalfOfUserId = user_dom`). | `slack/room.ts` `receive`, `slack.ts` `onEvent` | New task SL.10 (below) |
| 2 | must-fix | Any workspace member can create a team, add any active agent (TM's `addMember` asks nothing of the agent's owner), list that agent's app's channels (private channel names included), and link one. Every message of that channel then lands in a room that every workspace member can read (PROBE 1b: a member outside the team read the topic). The member's own room posts go out to the channel through the borrowed app (PROBE 1: `*usermallory:* hello from mallory` sent by Ada's app). | `teams.ts` `linkSlack`, `slackChannelList`, `slack/room-channels.ts` | New task SL.11 (below) |
| 3 | must-fix | "Always allow" on a room card in a channel thread writes a permanent `agent_tool_rules` row for the agent, whoever presses it. `requests.answer` calls `recordAlwaysAllow` → `putRule`, which skips the `requireAgentOwnerOrAdmin` check that `setRule` and `removeRule` make. PROBE 3: a linked workspace member who is not on the team and does not own the agent pressed it in Slack, and the rule was written with `updatedBy = user_eve`. PROBE 3b: the same call through the web succeeds too, so the gap predates SL. SL moved the card from the requester's DM into a channel where every linked member sees the button. Answering at all is fine by the project rule "any member can still answer any request" (`CLAUDE.md`). Changing the agent's rules is not. | `requests.ts` `answer`, `recordAlwaysAllow` | New task SL.12 (below) |
| 4 | must-fix | Nothing links a Slack user to an account inside a linked channel. `meetUnlinkedSender` (the email match) is reached only from `admit`, and `room.receive` returns before `admit` runs. So a team member who has never mentioned or DMed an agent outside a linked channel posts as "Name (Slack guest)" every time, wakes nobody, and is never told why. The fake hides it, because `seed-slack-room.ts` and the flow test insert Dom's identity link directly. `SL-e2e.md` "Before you start" says the app links a Slack user by email, and step 3 expects a post by you and an answer from A, so a fresh staging account fails there. | `slack/room.ts` `author`, `docs/reviews/SL-e2e.md` | New task SL.13 (below) |
| 5 | nit | `topicRootTs` reads the earliest room message of a topic in any channel. After a team is unlinked and linked to another channel, posts and cards in old topics go to the new channel with a `thread_ts` from the old one. What real Slack does with that is unverified, since the fake accepts anything. Filter by the current link's Slack team and channel. | `slack/room-out-store.ts` | Fold into SL.11 or a small fix |
| 6 | nit | A room card goes only through the requesting agent's own app, with no fallback. When that app is not in the channel, every try fails, the owner gets the problem item, and the person who could answer sees nothing in Slack. Before SL the card went to their DM. Step 10 with B removed (step 11) is not in the walkthrough. | `slack/requests.ts` `roomDestination` | Fall back to the DM path when the room send fails, or say so in `SL-e2e.md` |
| 7 | nit | A card in a channel shows the tool and its input (secrets are masked, other content is not) to every channel member. That includes Slack guests and Slack users with no Agentum account. Before SL only the requester saw it. Dom should confirm that this is intended. | `slack/requests.ts`, `request-cards.ts` | Dom decision |
| 8 | nit | The flow test's card case starts the run with `session: { origin: "ui" }`, which only Dom can see. A room run's session is `origin: "inbox"`, visible to every member. So the test never covers who else may press the buttons, which is how findings 3 and 7 went unseen. | `apps/web/src/server/slack-room-flow.test.ts` | Use an inbox session in the test |
| 9 | nit | The SL.3 and SL.4 reviews noted that `teams.slack.status` makes a membership call and a name call per member app, and that `room-status.ts` reads any failure as "not in the channel". I confirmed both at 2ba09899. What is new here is the live effect. Every workspace member can read it, the room header reads it on every room page view, and real Slack rate-limits `conversations.info` while the fake never does. A busy room then shows false `/invite` lines. The read also shows a private channel's name to every member. | `slack/room-status.ts`, `room-slack-link.tsx` | Store the name at link time and cache membership, or a name-only read for the header |
| 10 | nit | A Slack identity link is trusted with no fresh membership check. A person removed from the organisation who keeps the link and a `team_members` row would still post as themselves and wake agents from a linked channel. `git grep` at 2ba09899 finds no code that deletes an identity link, and `team_members` rows go only through `teams.removeMember`. The per-agent path has the same gap, and SL makes its reach bigger. | `slack.ts` `findLink`, `slack/room.ts` | Check org membership (the cached `isOrgMember`) before posting as a person |
| 11 | nit | `searchRoomMessages` does not exclude archived teams, though `findRoomLink` and `findOutboundRoom` do. An archived team's agents can still search its linked channel. | `slack/room-search.ts` | Add `isNull(teams.archivedAt)` |

Signing and replay on the routes are sound. `routes/slack.ts` passes the raw body and both headers through unchanged, answers 401 on a bad signature, and a throw becomes a 500 that Slack retries. No dev-only branch skips the check. Events and interactions both find the app by `api_app_id`, verify HMAC-SHA256 against that app's own secret with a 5-minute window and a constant-time compare, and then check `team_id`. A replayed event inside the window adds nothing, because the room's `slack_room_messages` key is unique on (Slack team, channel, ts). A replayed click hits an already answered request and only settles the card. The room path writes no `slack_events_seen` row, and it does not need one. Finding 1 is not a signature bug. The signature proves that the app's owner or Slack sent the event, and the room trusts every app in the workspace equally.

## Must-fix tasks

### SL.10 Only the team's own apps feed its room

Scope.

- In `slack/room.ts` `receive`, after `findRoomLink`, drop the copy (answer `accepted`, write nothing, wake nobody) unless the delivering app belongs to an active agent that is a member or the lead of the linked team. Use the same membership rule as `memberSenderApps`.
- A dropped copy must not fall through to the old per-agent path. A linked channel never feeds `slack_messages` or a per-agent run.
- Write down in the module header what is left. An owner of a member agent still holds a signing secret that can sign an event naming any Slack user. The default is to accept that, as the per-agent path already does, and list it as an assumption in the task file. Dom can ask for a check against Slack instead, such as reading the message back with `conversations.history` before a person's post wakes anyone.

Check.

- A route test signs an event with the secret of an installed app whose agent is not on the team, names a linked person in the linked channel, and asserts no post, no `slack_room_messages` row and no run.
- The same event from a member app still records one post and wakes the lead.
- The SL.5 flow test and `bun run check && bun run test && bun run build` pass.

### SL.11 Linking needs a person who is in the channel

Scope.

- `teams.slack.channels` lists only the channels the requesting person is in on Slack: their Slack identity link in that Slack team, checked with `conversations.members` or `users.conversations` through the vouching app. An admin may see all.
- `teams.slack.link` refuses unless the person is linked to Slack and is a member of the channel. An admin skips this check. The error says what to do.
- A private channel's messages land in a room that every workspace member can read. The default is that only an admin may link a private channel, and the team page says so. List it as an assumption Dom can change.
- `topicRootTs` filters by the team's current Slack team and channel (nit 5).
- Note for the TM owner: `teams.addMember` adds any active agent without its owner's consent. That is the root of this finding and sits outside SL. File it as its own task if Dom agrees.

Check.

- `teams.test.ts`: a member who owns the team but is not in the channel on Slack cannot list it or link it. A person who is in it can. A private channel follows Dom's rule.
- A flow test: after a relink to a second channel, a post in an old topic opens a new thread in the new channel. It carries no `thread_ts` from the old one.
- `bun run check && bun run test && bun run build` pass.

### SL.12 Always allow is for the agent's owner

Scope.

- In `requests.answer`, an `always_allow` decision from a person who is not the agent's owner and not an admin fails before the request closes, with the message "Only the agent's owner can always allow this. Allow it once instead." Keep "any member can answer any request" for allow once and deny.
- The Slack card path shows that message as an ephemeral reply and leaves the card open. The button stays on the card for everyone, because Slack cannot hide a button per viewer.
- `principalOf` in `slack/requests.ts` builds the Slack principal with no `isAdmin`, so an admin who does not own the agent is refused in Slack. That is the default. They can still always allow from the web.
- `putRule` callers other than `setRule` get the same guard, so the bypass cannot come back.

Check.

- `requests.test.ts`: a member who does not own the agent sends `always_allow`. It is refused, the request stays open and no rule is written. The owner and an admin succeed.
- A flow test: a linked non-owner presses Always allow on a room card in the fake Slack. They get the ephemeral refusal, no rule is written, and the card stays open.
- `bun run check && bun run test && bun run build` pass.

### SL.13 A Slack user is linked in a linked channel too

Scope.

- In `slack/room.ts` `author`, when the Slack user has no identity link, run the same match as `meetUnlinkedSender`: Slack email, then a Clerk user with that verified address, then org membership. When it matches, write the link and post as that person, if they are in the team. Run it only for users of the app's own Slack team. Skip a Slack Connect user from another organisation, whose email that organisation controls.
- Every member app hears the message and runs `author`, so the lookup runs once per copy. The link insert already uses `onConflictDoNothing`, so that is safe. Only the copy that wins the post write sends a reply, from its `after` job.
- When there is no match, the post stays a guest post. The guest gets one ephemeral reply in the thread saying how to get linked. Send it once per person, remembered through the existing `slack.unlinked_sender` event, so no schema change is needed.
- Fix `docs/reviews/SL-e2e.md` "Before you start" and step 3 so they match what the code does.

Check.

- `slack-events.test.ts`: with the directory returning a matching org member, the first message from an unlinked team member posts as that person, writes the identity link and wakes the lead. A non-member with no match gets one ephemeral reply and stays a guest. An external Slack Connect user is not linked by email.
- The SL.5 flow test passes with the seeded identity link removed from at least one case.
- `bun run check && bun run test && bun run build` pass.

## Controller decisions (2026-11-21)

- Must-fix 1 to 4 became SL.10 to SL.13, with the reviewer's defaults taken as decisions and logged in each task file.
- Nit 7: accepted. A card in a linked channel shows the tool and its input to the channel, with secrets masked, as the walkthrough designed it. Dom can reverse this.
- Nit 5 is folded into SL.11. The other nits stay recorded here.
