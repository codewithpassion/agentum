# HM.6 review: one working indicator with a queued reply

Branch `task/HM.6-one-working-indicator-with-a-queued-reply`. Verdict: clean after 1 fix round.

## Rounds

1. Round 1 on 31dbc389: must-fix. The task's component test (a working run plus a queued run renders one working indicator, and the queued message renders without a spinner) was missing. Fixed in f9a6b12e, which renders the real thread containers in `reply-while-working.test.tsx`.
2. Round 2 on f9a6b12e: clean.

## Cause and fix

Two causes. The protocol fold maps `queued` and `offered` runs to a `running` status, so a queued reply's empty assistant turn drew its own "Working" spinner. The task page now drops the turn of a run that waits behind work (`withoutWaitingTurns` in `thread-activity.ts`), so only the waiting user message with Remove stays. And `activeRun` in the room's now logic fell back to the newest open run when nothing was running, which was the newest queued reply. It now falls back to the oldest open run, because runs start in order.

## Browser steps skipped

The HM.4 flow with a machine agent on the fake daemon, desktop and phone, is left for the one browser pass. To check: with the fake daemon not claiming, send a second message. The task page shows one "Working" turn spinner, the second message shows "Waiting for the current step to end" with Remove and no spinner, and "Right now" names task 1, not the second message.

## Nits left

- The root cause in `packages/protocol/src/thread.ts` (`statusOf`) is left as is. The fix hides the turn in the view, because other consumers share the fold.
- The bottom bar still shows its own "Task N is working." strip next to the one turn spinner. The browser pass should decide whether that counts.
- `activeRun` reads `tasks.list` across all of the agent's sessions. A run stuck in `queued` or `offered` in an old session, such as one on an offline machine, now holds "Right now" over a newer task in another session when nothing is running.
- When the page shows the waiting run itself, its turn is hidden, so `lastAnswer`, `filesLine` and `failure` point at a message that is not drawn.
- The new render test repeats the filter wiring of `task-thread.tsx` instead of rendering `TaskThread`, and its `svg.animate-spin` assertion cannot fail.

## Ideas beyond the scope

- Show "1 reply waiting" on the Right now card.
- Fix the `queued` to `running` status mapping at its source and give a waiting turn its own status.

## Steps for Dom

None.
