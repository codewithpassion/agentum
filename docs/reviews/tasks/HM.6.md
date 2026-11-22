# HM.6 review: one working indicator with a queued reply

Branch `task/HM.6-one-working-indicator-with-a-queued-reply`. Verdict: clean after 2 fix rounds.

## Rounds

1. Round 1 on 31dbc389: must-fix. The task's component test (a working run plus a queued run renders one working indicator, and the queued message renders without a spinner) was missing. Fixed in f9a6b12e, which renders the real thread containers in `reply-while-working.test.tsx`.
2. Round 2 on f9a6b12e: clean.
3. The controller then asked for two nit fixes, done in af76dfa1: the bottom bar strip lost its own spinner, so the task page has one (the turn's "Working"), and `activeRun` takes the oldest open run in the newest session, so a stale queued run in an old session does not hold Right now. Round 3 on af76dfa1: clean.

## Cause and fix

Two causes. The protocol fold maps `queued` and `offered` runs to a `running` status, so a queued reply's empty assistant turn drew its own "Working" spinner. The task page now drops the turn of a run that waits behind work (`withoutWaitingTurns` in `thread-activity.ts`), so only the waiting user message with Remove stays. And `activeRun` in the room's now logic fell back to the newest open run when nothing was running, which was the newest queued reply. It now falls back to the oldest open run, because runs start in order.

## Browser steps skipped

The HM.4 flow with a machine agent on the fake daemon, desktop and phone, is left for the one browser pass. To check: with the fake daemon not claiming, send a second message. The task page shows one "Working" turn spinner, the second message shows "Waiting for the current step to end" with Remove and no spinner, and "Right now" names task 1, not the second message.

## Nits left

- The root cause in `packages/protocol/src/thread.ts` (`statusOf`) is left as is. The fix hides the turn in the view, because other consumers share the fold.
- On the page of a queued run with 3 or more earlier runs, the folded view hides the working run's turn and the queued run's own, so only "Task N is working." shows, without a spinner.
- A run that is "waiting" with no pending request is in the working state, but its turn reads "Waiting for an answer" without a spinner.
- A running tool card has its own spinner next to the turn's "Working", so a tool call shows two spinners (predates HM.6).
- The strip's text no longer carries `role="status"` that the removed spinner had.
- When the page shows the waiting run itself, its turn is hidden, so `lastAnswer`, `filesLine` and `failure` point at a message that is not drawn.
- The render test repeats the filter wiring of `task-thread.tsx` instead of rendering `TaskThread`.

## Ideas beyond the scope

- Show "1 reply waiting" on the Right now card.
- Fix the `queued` to `running` status mapping at its source and give a waiting turn its own status.

## Steps for Dom

None.
