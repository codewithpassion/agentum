# SP.11 review: the workspace cap holds at the start of a run

## Verdicts

- Round 0, commit 30eb73de: not clean. One must-fix: with no workspace cap, a start still read the workspace row, against "With no workspace cap the check costs no query".
- Round 1, commit b526f1d8 (fix): clean. `findAgentWithWorkspaceCap` carries the cap in the agent read, and `refuseIfWorkspaceOver` skips `spend.workspaceOver` when the cap is null. A test counts calls to `workspaceOver` (0 with no cap, 1 with one) and fails without the null guard.

## Nits left

- The non-admin pause card still shows the "Raise the workspace limit" link, which leads to `/settings/spend` where a non-admin can only read. The task asked only to drop Resume.
- The wording a non-admin reads ("Only raising the workspace limit lets this agent run, and an admin sets it.") is built in `SpendPause`, and no test covers it. The view test passes its own text.
- `findAgentWithWorkspaceCap` repeats the where-clause of `findAgent`.
- The guest start path has a refusal test but no test that an uncapped workspace skips `workspaceOver`. Only `startRun` has the counting test.
- On an over-cap workspace a malformed start gets `agent_paused` instead of `invalid`, because the gate runs before the adapter and reply checks. `refuseIfPaused` already behaves this way.

## Ideas beyond the scope

- A paused agent refused by `refuseIfPaused` says "Its weekly limit was reached" even when the workspace limit paused it. Giving that case the workspace message would read better.
- Hide the "Raise the workspace limit" link from non-admins, or show them who the admins are.

## Steps for Dom

None.
