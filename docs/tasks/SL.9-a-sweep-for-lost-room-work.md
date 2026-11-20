---
id: SL.9
title: "A sweep for lost room work"
milestone: SL
size: S
status: todo
depends_on: [SL.8]
branch: null
lane: slack
executor: claude
---

Proposed by the Slack walkthrough (`docs/reviews/SL-e2e.md`).

Finding. The room wake (SL.2) and the room send (SL.3) both run in `waitUntil` with no backup. A lost job loses that wake or that message, and nothing retries it.

Scope. A minute-tick job that wakes the lead for room posts no wake has seen, and sends posts in a linked room that have no `out` row.

Check. Tick test that drops the deferred job and sees the sweep finish the work once.
## Log
- 2026-11-21: added by controller.
