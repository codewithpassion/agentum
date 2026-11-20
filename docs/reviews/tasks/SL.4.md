# SL.4 review: Link a Slack channel on the team page

Haiku workers wrote `slack-logic.ts`, `slack-section.tsx` and `room-slack-link.tsx` with their tests. The dispatcher wrote the service side (`slack/room-channels.ts`, `teams.slack.link`, `unlink` and `channels`, the `channelName` on `slack.status`), the `SlackLink` container and the wiring. Reviewed by Opus. The browser was driven by two fresh verifiers: `docs/reviews/tasks/SL.4/browser.md`.

## Verdict

Round 1, commit f1694564: clean. No must-fix findings. No fix rounds.
Browser proof: pass at 1280x800 and 390x844 for flows 1 to 6 (the second verifier closed flow 5 with a real non-admin member).

## How it works

The Slack block sits in the right column of `/teams/$teamId`. `SlackLink` reads `teams.slack.status` when it mounts, so a slow Slack never holds up the page loader. For an editor of an unlinked team it also reads `teams.slack.channels`, the channels the lead's app is in (the oldest member app when there is no lead). Link sends the Slack workspace id and channel id back; the service checks that a member app in that Slack workspace is a member of the channel, then writes the row. A linked block shows the channel name, Unlink for editors, and `missingSlackApps` (agents whose app is not in the channel, each with `/invite @<bot name>`, or "has no Slack app yet"). The room header shows `Slack #name` from one status read per page, for both the desktop and the phone header.

## Decisions the task left open

- SL.1 left `slack.link` and `slack.unlink` as stubs and no task filled them (SL.3's review said so), so this task implements them, plus a `teams.slack.channels` query for the picker and a `channelName` field on `TeamSlackStatus` (one line in `packages/db/src/shared.ts`). The channel name is read live from Slack because the link table has no name column and the schema is closed.
- "Channels the lead's app can see" is read as the channels its bot is a member of (`users.conversations`), the list `client.listChannels` already gives.
- Only the team's owner or an admin links, unlinks or lists channels (`writableTeam`). Unlink works on an archived team, link does not.
- Unlinking an unlinked team does nothing. The `slack_room_messages` rows stay.
- The invite name is `botNameFrom(agent name)`, so `botNameFrom` is exported from `slack/manifest.ts`.

## Nits left

- `teams.ts` link: two concurrent links for one team that lose the race report "linked to another team" instead of "this team is already linked".
- `room-status.ts`: `nameOf` makes its own `conversations.info` call per app, on top of the membership calls. Every status read asks Slack about twice as often as it needs to.
- The room header reads the full `slack.status` (a Slack call per member app) only for a label. A name-only procedure would be cheaper.
- `slack-logic.ts`: the invite line comes from the agent's current name, so it is wrong when the agent was renamed after its app was made, and it reads `/invite @unknown-agent` for an agent missing from the roster.
- `teams.$teamId.tsx`: `canEdit` is false for an archived team, so Unlink is hidden although the service allows it. The comment above it lacks that exception.
- Readers still see "Link the team's room to one Slack channel." under the Slack heading.
- The archived-team banner says "Only an admin or the team's owner can change this team" even for an admin (older TM.6 text).

## Ideas beyond the scope

- A copy button on each `/invite` line.
- Store the channel name on `team_slack_links` in a contract task, so the room header needs no Slack call.
- The agent-browser CLI (0.14.0) ignores `network route --body`; the verifier sent the route to the daemon socket instead.

## Steps for Dom

Needs a real Slack workspace. All tests and the browser run used stubbed Slack calls (`slack.channels` and `slack.link` stubbed in the browser, a fake Slack fetch in the service tests).

1. Install Slack apps for two or three agents of one team in one Slack workspace (Agent, Slack tab). Make one a lead. Create a channel `#sl4-test` and `/invite` only the lead's bot.
2. Open `/teams/<id>` as the team's owner. Under Slack, expect `#sl4-test` in the picker (and any private channel the lead's bot is in). Pick it and click Link channel.
3. Expect "Linked to #sl4-test", and each other agent whose bot is not in the channel with a line `/invite @<bot name>`. Paste one line in the channel in Slack, reload the team page, and expect that agent to leave the list. When every bot is in, expect "Every agent's Slack app is in the channel."
4. Open the team room. Expect "Slack #sl4-test" under "Team room" on desktop and under the title on a phone.
5. Try to link the same channel from a second team. Expect "That Slack channel is linked to another team." Try to link a second channel on the first team. Expect "This team is already linked to a Slack channel. Unlink it first."
6. Sign in as a workspace member who is not an admin and does not own the team. Expect the channel and the invite lines but no picker and no buttons.
7. Click Unlink. Expect the picker again, and posts in the channel no longer reach the room.
8. Run the SL.3 and SL.2 live steps (`docs/reviews/tasks/SL.2.md`, `SL.3.md`); step 1 of each can now use Link instead of inserting the row.

## Checks

`bun run check`, `bun run test` and `bun run build` pass at f1694564. Service tests: `teams.test.ts` (link, unlink, channels, authorisation, uniqueness), `slack/room-channels.test.ts` (fake Slack), `slack/room-status.test.ts` (channel name). Component tests: `slack-section.test.tsx` (the missing-apps list), `slack-logic.test.ts`, `room-slack-link.test.tsx`.
