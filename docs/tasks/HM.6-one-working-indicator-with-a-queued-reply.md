---
id: HM.6
title: "One working indicator with a queued reply"
milestone: HM
size: S
status: in_progress
depends_on: [HM.4]
branch: null
lane: web-thread
executor: claude
---

From the HM browser pass (`docs/reviews/hm-browser.md`, flow 4) and Dom, 2026-11-23.

Finding. While a task works and a reply waits behind it (HM.4), the task page shows two "Working" spinners, and the room's "Right now" card shows the queued message's text instead of the task that is running.

## Scope

1. The task page shows exactly one working indicator while a step runs, queued replies or not. A queued reply shows only as the waiting message with Remove, never with its own spinner.
2. "Right now" names the run that is actually working. A queued run is not "now"; at most it adds "1 reply waiting".
3. Find the cause first (likely the queued run counting as active in the thread state or the room's now query) and fix it there rather than hiding a spinner.

## Check

- Component tests: a working run plus a queued run renders one working indicator, and the queued message renders without a spinner.
- A test for "Right now" (component or service, wherever the cause is) that picks the working run over a newer queued one.
- `bun run check` and the changed packages' tests and build pass.
- Browser at the end pass: the HM.4 flow with a machine agent on the fake daemon, desktop and phone.

## Log
- 2026-11-23: added by controller from the HM browser pass and Dom's request.
- 2026-11-23: dispatched.
