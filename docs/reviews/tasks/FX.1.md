# FX.1 review

Round 1 at 902593f3: clean, no must-fix. Nothing was run by the reviewer beyond Biome on the changed files; the dispatcher ran the checks below.

## Cause

Guest execution (`guest-execution.test.ts`). The runner read some response bodies and left the rest unread, mostly the bodies of `post()` calls. undici cancels an unread body when its `Response` is garbage collected, and that destroys the pooled keep-alive socket. By then the socket carries the next request, which dies with `UND_ERR_SOCKET` "other side closed" or `ECONNRESET`. When it happens depends on garbage collection, so it looked random and got worse on a busy host. The old failure was never a workerd restart or a port clash: workerd stayed up, and four runs started together failed at the same step, the first `advance` after the `answer-preview` call, in under 40 ms. The same four runs with every body read all passed (4/4 against 4/4 failing). The `Offering the next run of agent a1 failed: Not allowed: runs.guest_access` log line is expected: it is printed when the test downgrades a guest to viewer and the owner's next run offer is refused.

Room (`room.test.ts`). The runner raced fixed pauses and a 300 ms timer against the host. The failure seen was "a downgrade during the lookup refuses the in-flight write": the test meant to change the role while the lookup was in flight, but it did so with `pause(100)` and two HTTP calls against a 300 ms lookup delay. On a loaded host those calls took longer than the delay, the lookup answered `editor` first, and the write was applied legitimately. It failed 1 run in 10 alone on this host. With 150 ms of extra latency on every harness call, the old runner fails exactly that assertion and the new one passes. The same shape sat in the straddle test, the eight-admission timing bound (`admitMs < 1200`) and about twenty short pauses before positive checks. `fails()` also left response bodies unread, the same cause as above.

Services backlog test (`runs.test.ts`, "an hour of never-claimed runs"). It is not a bug in the sweep. The test runs about 3200 start-and-sweep rounds one after the other, and a profile shows a flat cost per round: `start` takes about 1 ms and `sweepQueuedRuns` 15 to 24 ms, whether the run count is 500 or 4000. That is the sweep re-offering the roughly 60 queued runs of the simulated hour on every minute tick (at most `SWEEP_BATCH`, 100). So the test needs 50 to 57 s on one core against a 60 s cap, and any contention pushes it past, which is why it passes alone and fails at 65 to 78 s in full runs. No query grows with the backlog, so there is nothing to fix in `runs.ts`. The cap was too tight for the work.

## Fix

- `guest-execution-runner.mjs`: `request()` reads each body in full. The SSE stream uses a separate unbuffered `open()`.
- `runner.mjs`: `eventually()` polls for state before every positive check that followed a short pause. `sendSettled()` waits until the room has finished delivering a frame (a per-room counter in `worker.ts`, counted after `webSocketMessage` resolves, retries included) before the next HTTP read. A hold gate in the fixture room parks authorization lookups after they read their answer, so the "during the lookup" tests release them on purpose instead of racing a timer. The eight-admission test now asserts that eight lookups are parked at once, which fails if they are serialised.
- No assertion was removed or loosened. Real-time waits that are lower bounds (the 2.1 s grant window, the 5.1 s agent expiry, the 12 s hibernation idle) are unchanged.
- `packages/services/src/runs.test.ts`: the "an hour of never-claimed runs" test needs about 50 s of CPU against a 60 s timeout and failed two of three full runs under a parallel build (measured: 57 s for 3000 rounds alone on a busy host). The timeout is now 240 s and every `expect` is unchanged. The task file names this test as the third flaky one.

## Checks

- Each test passes 10 times in a row alone: `guest-execution.test.ts` 10 of 10 (122 to 140 s on this busy host), `room.test.ts` 10 of 10 (57 to 72 s).
- Twelve room runners at once all pass (123 checks each).
- Three full `bun run test` runs with `vite build` looping alongside: see the log in the commit that closes the task.

## Nits left

- `syncInto` accepts a kind 2 message as the answer to its sync step 1. Only kind 1 answers step 1. A late broadcast could end the wait early. Unlikely with the current sequence.
- If a `check` throws while the gate is held, the pending `refreshing`, `straddling` or `admissions` promises reject during dispose and can hide the real assertion message. It matters only when the test already fails.
- `holdAuth()` replaces `gate.wait` without settling the previous promise. Nothing holds twice.
- Helper checks ("frame delivery finished", "room answered the sync request") count toward the `passed >= 60` floor in `room.test.ts`. The runner now reports 123 checks.
- Two short pauses remain (the cross-peer spoof check and the hibernation awareness frame). Neither can fail under load.
- `authDelay` is now used only by the expired-grant burst test.

## Beyond scope

- `guest-runner.mjs`, `production-runner.mjs` and `deck-runner.mjs` build on the same `dispatchFetch` pattern. They were not flaky in the task and were not read for unread bodies. A grep for `await post(` / `await request(` results that are never read would find any that are.
- The services backlog test runs 3200 start-and-sweep rounds. Making each round cheaper would remove the need for a long timeout.
- LR.17 (room admissions in the Durable Object) is untouched, as the task asks.

## For Dom

None.
