# SL.9 review: A sweep for lost room work

One Haiku worker wrote the two sweep queries (`slack/room-sweep-store.ts`) and their tests. The dispatcher wrote `inbox.retryPostWake`, `slack/room-sweep.ts`, the wiring (`compose.ts`, the `slack.roomSweep` tick job in `tick/slack.ts`, `slack/room-out.ts` now returns `send`) and the two tick tests in `apps/web/src/server/slack-room-flow.test.ts`. Reviewed by Opus.

## Verdict

Round 1, commit 6afd96e1: not clean. One must-fix: both queries filtered on `inbox_posts.created_at`, which has no index, so every tick read the whole posts table. A second finding (two overlapping ticks could work on one post) was fixed too.
Round 2, commit 8b6bb059 (fixes only): clean. No must-fix findings.

Fixes made in round 1: the window also bounds the post id (ULID time prefix, a minute of slack), so the primary key is searched. "No run since the post" reads `sessions.lastRunAt`, which a run's creation sets in the same write, because `runs` has no `session_id` index. The sweep stops taking up posts after 45 seconds, so it ends before the next tick.

## How it works

The `slack.roomSweep` job runs every minute. It looks at posts created between one hour ago and two minutes ago, so a job still in `waitUntil` is left alone and a post the sweep cannot finish is not retried for ever.

Sends. A post in a team room whose Slack link is older than the post, whose topic is not limited, that is not a guest post, and that has no `slack_room_messages` row and no `slack.room_send_failed` event goes through the same `send` the `inbox.posted` listener uses. Oldest first, so the first post of a topic opens its Slack thread. `send` checks again that no row exists.

Wakes. A person's post that came in from Slack (an `in` row, author kind user, not a guest), in a room that is still linked, with no run started in the topic's inbox sessions since the post and no `inbox.loop_stopped` event for it, goes to `inbox.retryPostWake`. That runs the normal `wake` as the post's author, so mentions, the listening lead, the streak and budget stops and the archived-team rule all apply. A wake that is refused records its stop, so the post is not picked again.

The tests drop the lost job and run the tick twice. For the wake, the deferred after-answer job of a Slack message is thrown away, and the tick starts one run for the lead and its answer goes to Slack once. For the send, a post is written with no send (the job died before it ran), a tick inside the grace does nothing, a tick after it sends one message through the lead's app in the topic's thread and writes the `out` row, and a second tick sends nothing.

## Nits left

- The "a run answered it" check ignores which agent ran. If a post names Cy, Cy's wake is lost and Ada runs in the topic later, the post looks handled.
- A post whose first wake found nobody to wake (a lead who does not listen, a mention of an inactive agent) leaves no run and no stop, so it is checked every minute for an hour. If the lead starts listening in that hour, it is woken late for that post, at most once.
- A post that is only attachment markers is empty after `send` strips them, so `send` writes no row and the sweep picks it again every minute for an hour.
- The queries return the 50 newest posts. With more than 50 lost posts the oldest are left to fall out of the window, and a later post could open the Slack thread.
- The 45 second budget is checked between posts. One send or wake that hangs can still run into the next tick.
- `sessions.lastRunAt` holds the last written run's time, so two runs started in the same millisecond on one session could leave it at the earlier one. Harmless.
- A Slack post that succeeds when the Worker dies before `recordOutMessage` is sent again by the sweep. This was already true of the send path.
- The `events` lookups by `json_extract(payload, '$.postId')` read every stop or failure event of the workspace per candidate. Fine at today's volumes.
- The send test writes the post row directly, with no `inbox.posted` event, because the listener's send is already running when `defer` gets it and cannot be dropped.
- The store tests use string ids such as `p-match`, which always sort above the ULID bound, so no unit test covers the id bound itself. The flow tests use real ULIDs.

## Ideas beyond the scope

- An index on `runs.session_id` and `inbox_posts.created_at` would make these lookups and several others cheaper, in a contract task.
- A `retryPostWake` that knows the target agent could close the first nit.

## Steps for Dom

None. The sweep needs no account or dashboard. The browser steps of the check were skipped (the task's check has none). Nothing ran against a real Slack workspace.
