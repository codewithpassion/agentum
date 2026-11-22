# HM.4 review: reply while a task is working

Branch `task/HM.4-reply-while-a-task-is-working`. Verdict: clean after 2 fix rounds.

## Rounds

1. Round 1 on 6bde0a5c: must-fix. `sendWhileWorking` let any member start a run in any visible session whatever its origin, and a steered message that Pi answered after the run's own input (final boundary or an idle submit) had no follower. Fixed in 74fe20d1: only a `ui` session or a sub-thread takes the message, and each steer operation is recorded on the stored run and waited for before the run completes.
2. Round 2 on 74fe20d1: must-fix. Stop and the safeguards could not stop a steer's own turn, and a steer could submit after the work stopped waiting for steers. Fixed in 2781d794: `abortSteers` aborts every recorded steer, `steer` records before it submits and refuses once `closing` is set, and artifact sessions stay refused.
3. Round 3 on 2781d794: clean.

## How it works

`runs.sendWhileWorking` takes the working run's id. A `running` Cloud run on a message without files takes it as a Pi steer (`RuntimeAdapter.steer`, `CloudRunnerPort.steer`, Durable Object `steerRun`), and the service then appends a `message.user` event with `steered: true` to that run. Anything else, including a refused steer, starts the session's next run through the normal start path, which the claim keeps waiting. Removing a waiting message is the existing `runs.cancel`. `offerNextOnEnd` is now set on the machine and fake adapters, so a waiting run starts as soon as the current one ends. The managed runtime keeps its own next-run offer, because setting the flag there offered each run twice.

## Browser steps skipped

The task's "send while a fake-runtime task works, see it queued, then run" pass is left for the one browser pass after all tasks merge. To check: send a second message while a fake-runtime task works (the box stays open, the note reads "The agent gets this when the current step ends.", the message shows "Waiting for the current step to end" with Remove), remove one, and let one run. The Cloud steer path was tested with the faux Pi only.

## Nits left

- A steer in flight when a safeguard fires can escape it, because `steer` does not check the stored `stop` (pi-run-core.ts, `steer`).
- The abort after a late submit can hit the next run's turn in a tiny window, and `steer` saves its record with a read-modify-write that a `finishRun` could overwrite.
- A steer whose turn ends in a model error still completes the run as done.
- A repeated `requestId` on a steer appends a second `message.user`. If the DO call fails after Pi took the steer, the message is queued as well and the agent gets it twice.
- Pause and workspace-cap refusals apply to a steer into work already under way.
- A run cancelled before it started counts as removed, so an old stopped queued task leaves the history. A queued run held back by the agent working in another session has no Stop or Remove on this page.
- The Cloud note "The agent reads this as it works." is wrong when the message is queued instead (files, refused steer).
- A long steered message (payload stored out of line) is placed before the answer, not after it.
- No test for the branch of `steer` that aborts after a late submit, the safeguard abort path, or an artifact session refusal.

## Ideas beyond the scope

- Split the assistant message at the point of a steer, so the steered message sits in the middle of the answer where it arrived.
- Let a steer carry files.
- Show a short "sent to the agent" mark on a steered message.

## Steps for Dom

None.
