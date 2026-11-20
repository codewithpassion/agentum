# SL.2 review: Slack to room, one post per message

Two Haiku workers wrote `slack/room-text.ts` and `slack/room-store.ts` with their tests. The dispatcher wrote `inbox.postExternal`, `slack/room.ts`, the wiring and the route tests. Reviewed by Opus.

## Verdict

Round 1, commit 6817bff7: clean. No must-fix findings. No fix rounds.

## How it works

A channel in `team_slack_links` is the room's. Each member app calls `slack/room.ts` with its own copy of an event. `inbox.postExternal` writes the topic (when new), the post and the `slack_room_messages` row in one atomic write, so the unique key lets one copy win and the others leave nothing. A thread reply finds its topic through `slack_room_messages` by `ts` or `thread_ts`. A linked person who is in the team posts as themselves and wakes agents through `inbox`'s `wake` (`@slug` for a mentioned member app, else the lead when `lead_listens`), in the after-answer job. Anyone else posts as a guest (`author_kind` user, `author_id` `slack:<slackTeamId>:<userId>`, text prefixed `<name> (Slack guest): `) and wakes nobody. A bot message, or a message from any installed app's bot user, is dropped. An unlinked or archived-team channel takes the old path.

## Decisions the task left open

- No schema change is allowed in this task, and `INBOX_AUTHOR_KINDS` has no guest, so a guest is a `user` post with a Slack-derived author id and the name in the text.
- `compose.ts` passes `inbox` to the Slack service (one line) and `inbox.ts` gains `postExternal`. Both are outside the file list, and neither can be avoided.
- Messages in a linked channel are no longer stored in `slack_messages` and never batch into a per-agent run. The room is their history.
- A linked person who is not in the team posts as a guest.
- Edits and deletions in a linked channel still go through the old `slack_messages` path and do not change the room post.

## Nits left

- `inbox.ts` `postExternal` does not check `canPostInTopic` for the author in an existing topic. Topics opened from Slack have no member rows, but SL.3 may map limited topics to Slack threads. SL.3 must not write `out` rows for limited topics, or this check must be added.
- The text is cut to `INPUT_TEXT_MAX` before the guest label is added, so a guest post can run about 95 characters over. The cut counts UTF-16 units.
- Titles and post text keep raw Slack markup (`<@U..>`, `<https://..|..>`, `<#C..|..>`).
- A message with files and no text is dropped. Files are not carried into the room.
- `isAppBotUser` drops messages from any installed app's bot in the workspace, not only team members' apps.
- Two copies of different messages can race and open two topics for one Slack thread (two replies to an unrecorded parent).
- In a linked channel, an `app_mention` of an app whose agent is not in the team now does nothing. Before, that agent answered.
- A topic a guest opens stores `created_by` as the guest id, not a Clerk id.
- No test reaches the branch where a `receive` loses the key mid-write. `postExternal` is tested directly for that.
- The unlinked-channel test covers a mention only. The slack-listen tests cover plain messages.
- The wake runs in `waitUntil` with no backup. A lost job loses that wake. The minute tick does not retry room wakes.

## Ideas beyond the scope

- A `guest` author kind (or a name column) in a contract task, so the name stops living in the text.
- A minute-tick sweep that wakes the lead for room posts that no wake has seen.

## Steps for Dom

Needs a real Slack workspace, so none of it ran against Slack. Test with two or three member apps installed and invited to one channel.

1. Link the channel to a team's room. `slack.link` is still a stub until SL.4, so insert the row on a dev database: `insert into team_slack_links (id, workspace_id, team_id, slack_team_id, channel_id, linked_by, created_at) values (...)` with the Slack team id (`T...`) and channel id (`C...`).
2. Post "hello room" as yourself, a linked and team-member Slack user. Expect one new topic titled "hello room" and one post by you in the team room, not one per app. With `lead_listens` on, the lead wakes once.
3. Reply in that Slack thread. Expect a second post in the same topic.
4. Post `@<member app>` with a real app mention. Expect that agent to wake through the room, with no Slack-session run.
5. Post from a Slack account with no Agentum link. Expect "<Slack name> (Slack guest): ..." and no wake.
6. Post in a channel that is not linked. Expect today's behaviour.
