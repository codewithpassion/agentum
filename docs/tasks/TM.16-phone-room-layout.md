---
id: TM.16
title: "Phone room layout"
milestone: TM
size: S
status: done
depends_on: [TM.15]
branch: null
lane: web-room
executor: claude
---

From the teams walkthrough (`docs/reviews/TM-e2e.md`).

Finding. At 390x844 the sticky composer takes about 200px of the height and hides the last task chip. The topics sheet stays open after New topic creates a topic and closes only when a topic is tapped.

Scope. Shrink the composer on phone (one line until focused) and close the sheet when a topic is created.

Check. Browser at 390x844.

## Log
- 2026-11-21: added by controller.
- 2026-11-21: deferred to the backlog on Dom's scope freeze (only must-fix bugs stay in v4).
- 2026-11-22: back in scope on Dom's call (all deferred tasks except the flaky-test fixes).
- 2026-11-22: dispatched.
- 2026-11-22: merged at b31bb3c8, review clean after 0 fix rounds. Browser check at 390x844 moved to the end pass.
