# SL.1 review

## Verdict

Round 1, commit c5a36669: clean. No must-fix findings.

## What the contract holds

Migration 0059 adds `team_slack_links` (a team has one channel, a channel has one team: unique on `team_id` and on `slack_team_id` plus `channel_id`) and `slack_room_messages` (unique on `slack_team_id`, `channel_id`, `ts`). Both carry `workspace_id`, which `schema.test.ts` requires. Deleting a team deletes its link, and deleting a post deletes its message rows. `@repo/db/shared` has `TeamSlackLink`, `TeamSlackMemberApp`, `TeamSlackStatus`, `SLACK_ROOM_DIRECTIONS` and `SlackRoomDirection`. The `teams` service and router gain `slack.link`, `slack.unlink` and `slack.status` as stubs: they authorize, then reject with `not_found`, like the other TM.1 stubs. The service stays `{ atomic, clock, db }`, so `compose.ts` and `router.ts` did not change. `slack-link-contract.test.ts` shows a second team cannot link a taken channel and a team cannot link two.

## Nits left

- `packages/services/src/teams.ts`: the stub comment says wiring in `compose.ts` is final. `slack.status` needs to know which bots are in the channel, which may need the Slack gateway in `TeamsDeps`. Only a contract task edits `compose.ts`, so settle that before SL.2 starts.
- `packages/db/src/schema/slack.ts`: `slack_room_messages.post_id` is NOT NULL with a foreign key to `inbox_posts`. A caller must write the post and the row in one `atomic` batch, and the loser of a race gets a UNIQUE error, not a no-op. SL.2 must handle that conflict, or make `post_id` nullable.
- The unique key on `slack_team_id` plus `channel_id` spans all Agentum workspaces. `slack.link` should map the UNIQUE error to a neutral conflict.
- `TeamSlackLink` has no channel name, and there is no procedure to list channels for a picker. SL.4 needs both.
- The stub tests do not cover `slack.link` with the system principal.

## Beyond the scope

- No SL task names filling in the three `slack.*` bodies. Assign them to the service task.

## Steps for Dom

None. The migration is applied to remote D1 by the controller's deploy.

## Checks

`bun run check` and `bun run build` pass. `bun run test` passes except the known flakes: `guest-execution.test.ts` fails on main too, alone (it fails the same way with this commit stashed), and one `exports.test.ts` and one `runs.test.ts` timeout under load that pass alone.
