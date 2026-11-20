# TM.21 review: an archived team's room is read-only

## Verdicts

- Round 1 (75004576): not clean. Two must-fix: a running discussion kept waking agents in an archived team (the check sat in `wakeTargets`, not `wakeOne`), and the room thread said "You are not in {team}" in an archived room.
- Round 2 (dbb29c38, fix commit only): clean. Both fixed: `wakeOne` refuses an archived team, and the not-in-team line shows only for a live team.
- Browser proof (dbb29c38): pass at desktop and phone, see `docs/reviews/tasks/TM.21/browser.md`.

## Nits left

- `inbox.test.ts`: the discussion test covers the lead's checkpoint wake after a timeout, not a member wake inside a round.
- An archived team's running discussion adds one `inbox.loop_stopped` "refused" event per blocked wake per sweep until it expires.
- `wake` pays one extra team lookup per call (`wakeTargets` and `wakeOne` both check).
- No component test for the room thread's not-in-team line; `room-logic.test.ts` covers `isRoomMember` and `canPostInRoom`.
- On phone the archived line sits in the room header beside the Topics button, not inside the Topics sheet.

## Ideas beyond the scope

- Archiving a team could stop its running discussions, so they end at once instead of timing out.
- The Teams page has no archive action; the verifier used the `teams.archive` call.

## Steps for Dom

None.
