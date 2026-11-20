# SL.3 review: Room to Slack, posts and cards

Five Haiku workers wrote the store queries (`slack/room-out-store.ts`), the member-app status read (`slack/room-status.ts`), the desk and rail problem item, and the service-level tests of the sender. The dispatcher wrote `slack/room-out.ts`, `slack/room-failure.ts`, `slack/room-out-text.ts`, the card changes in `slack/requests.ts`, the `slack.status` body, the wiring and the route-level tests. Reviewed by Opus.

## Verdict

Round 1, commit f0d4ab7a: clean. No must-fix findings. No fix rounds.

## How it works

`room-out.ts` is an `events.onAppend` listener on `inbox.posted`. For each post it skips when the post already has a `slack_room_messages` row (a message that came from Slack, or a send that already happened, which is also the no-echo guard), when the topic's team has no Slack link, when the topic is limited (it has member rows), when the text is empty, or when the author is a Slack guest. Otherwise it picks the apps to try: the author's own app for an agent's post, then the lead's app, then the other member apps oldest first. An app that answers a config error (`not_in_channel`, a bad token), has no token, or cannot be decrypted hands the post to the next app. A post sent through an app that is not the author's own carries `*Name:* ` in front, and a person's post always does. The first post of a topic is a top-level message, its `ts` becomes the Slack thread root, and later posts reply in it. Every send goes through `withRetry`, up to three tries per app with backoff. When no app takes the post, `reportRoomFailure` writes a `slack.room_send_failed` event. The send runs in `defer` (`waitUntil`).

`desk.railSources` reads the newest failure per team for the viewer as the team's owner and hands it to the rail as a `problem` item (`runId` null, `threadId` set). It goes away when the team is unlinked or relinked, or a later `out` message of the channel is recorded. It has no Dismiss button.

A request card of a run whose reply target is a topic of a linked room goes into the topic's Slack thread through the requesting agent's own app. With no Slack thread yet, no app for the agent in that Slack workspace, or no link, the card keeps the old path (a DM to the person). A card that fails after the retries writes the same failure event.

`teams.slack.status` returns the link and, for each active agent member, its bot user id and whether its bot is in the channel (`conversations.info` with that app's token, new `channelMembership` on the Slack client).

## Decisions the task left open

- "Retry three times" is read as three tries per app, the existing `withRetry` helper. The task says `requests.ts` has no retry today, but it already used `withRetry` for posting and settling a card. This task only added the failure report after the last try.
- The problem item is read from the event log, not a new table, because no schema change is allowed here. One line was added to `EVENT_TYPES` in `shared.ts`.
- A card goes through the requesting agent's own app only. A click is answered by the app that posted it, and `handle` in `requests.ts` refuses a click on a request of another agent.
- Files outside the slack lane that changed: `compose.ts` (three lines: the outbound listener, `events` for the card service, the status read for teams), `teams.ts` (the `slackStatus` dependency and the status body), `desk.ts` and `rail.ts` (the problem item), `packages/db/src/shared.ts` (one event type), and two `exports` lines in `packages/services/package.json`.
- A team with no owner gets no problem item.

## Nits left

- `room-out.ts`: two posts sent before the first one's row is written open two Slack threads, because the root is read before the send.
- `room-out.ts`: a linked team with no member app in the Slack workspace writes a `no_app` failure event for every post. The item groups them, but the event log grows.
- Agentum `@name` mentions go out as plain text. The thread reply path of a Slack run turns them into Slack mentions.
- Agent markdown goes out as written, not converted to Slack's mrkdwn.
- A card for a topic that has no Slack thread yet goes to the person's DM, quietly.
- A problem about a card clears only when a later room message is recorded as `out`, not when a later card is posted. In a quiet room it stays up to 7 days.
- The problem item's "Open the thread" link comes from `rail-pane/problem-pane.tsx` and goes to `/inbox?thread=<id>`. Team topics live under the team's room route.
- `slack.status` reports an app as not in the channel when its check fails for any reason (a rate limit, a missing scope), not only when Slack says it is not a member.
- `room-status.ts` does not filter `team_members.workspace_id`, which `memberSenderApps` does. Team ids are unique, so this is a second safeguard only.
- Finding 1 of the review (text not escaped) does not apply: `client.postMessage` escapes `&`, `<` and `>` and keeps only real user mentions, so `<!channel>` in a post or a name goes out as text.

## Ideas beyond the scope

- No task fills `slack.link` and `slack.unlink` (still stubs from SL.1), and SL.4's UI needs both. Assign them to SL.4 or a service task before the UI starts.
- A minute-tick sweep that sends room posts that have no `out` row, for a lost `waitUntil` job.
- Show the "not in the channel" state and the `/invite @name` line from `slack.status` on the team page (SL.4).

## Steps for Dom

Needs a real Slack workspace, so none of it ran against Slack. Use a team with a lead and two other agents, each with its own installed Slack app, all invited to one channel, and the channel linked as in SL.2 (insert the `team_slack_links` row until SL.4 adds Link).

1. In the team room, open a topic and post "hello Slack" as yourself. Expect one message in the channel from the lead's app, starting with your name in bold, and not a second copy in the room.
2. Post again in the same topic. Expect a reply in the thread of the first message.
3. Post `@<member agent>` with a question. Expect the agent's answer in the same thread from that agent's own app, with no name in front.
4. Remove one member agent's bot from the channel (`/remove @name`), then make that agent post. Expect its message from the lead's app with `*<agent name>:*` in front. Call `teams.slack.status` for the team (the tRPC procedure, there is no UI yet) and expect that agent with `inChannel: false`.
5. Reply in the Slack thread as yourself. Expect one new post in the topic, and nothing posted back to Slack.
6. Give an agent a task from the room that needs an approval. Expect the approval card in the topic's Slack thread. Click Allow as a linked person. Expect the request to close in Agentum. Do it again and answer in Agentum instead. Expect the Slack card to settle.
7. Paste a bad bot token into the lead's app (or uninstall all member apps), then post from Agentum. Expect no Slack message, and a "Slack is missing <team> messages" item in Needs you for the team's owner. Fix the token, post again, and expect the item to leave.

## Checks

`bun run check`, `bun run test` and `bun run build` pass at f0d4ab7a, and the reviewer ran all three again on a clean checkout. The CI bundle grep found no `drizzle` in `apps/web/dist/client`.
