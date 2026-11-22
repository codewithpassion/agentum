---
id: HM.4
title: "Reply while a task is working"
milestone: HM
size: M
status: in_progress
depends_on: []
branch: null
lane: web-thread
executor: claude
---

Dom's screenshot on 2026-11-23: while a task runs, the task page replaces the reply box with "Task 3 is working. Reply when it is done." (`components/thread/bottom-bar.tsx`, `components/thread/task-thread.tsx:438`). Dom cannot send a follow-up or steer the agent until the run ends.

Background. C.3 deferred steering into a busy session, and C.13 kept one running run per agent, starting the next waiting run as soon as one ends. `apps/web/src/server/pi-run-core.ts` already has `whenBusy: "followUp" | "steer"` for the Cloud (Pi) runtime.

## Scope

1. The reply box stays visible and usable while a task is working, with the working indicator kept above it.
2. Sending while the task is working:
   - Cloud (Pi) runtime: the message is steered into the running session (`whenBusy: "steer"`), and it appears in the conversation right away as Dom's message.
   - Every other runtime (machine, managed, Anthropic cloud): the message is queued as the next turn of this conversation and runs as soon as the current run ends (C.13's offer-next path). The box says so in one line under it: "The agent gets this when the current step ends." The queued message shows in the conversation marked as waiting, and it can be removed before it starts.
3. The rule of one running run per agent stays. No message is lost: a steer that the runtime refuses falls back to the queue.
4. Stop stays available while working.

Read first: `docs/tasks/C.3-pirun-do.md`, `docs/tasks/C.13-gate-fixes.md`, `pi-run-core.ts`, `packages/services/src/runs.ts`, the two thread components above.

## Check

- Service tests: a send to a busy Cloud run steers; a send to a busy machine run queues and starts when the run ends; a refused steer queues; removing a queued message cancels it.
- Component tests: the reply box renders while working, with the right note per runtime.
- `bun run check` and the changed packages' tests and build pass.
- Browser at the end pass: send while a fake-runtime task works, see it queued, then run.

## Log
- 2026-11-23: added by controller from Dom's screenshot. Controller decision: steer on Cloud (Pi), queue as the next turn elsewhere.
- 2026-11-23: dispatched.
