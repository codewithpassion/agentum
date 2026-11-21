---
id: SL.6
title: "A fake runtime that asks for approval in a room"
milestone: SL
size: S
status: done
depends_on: []
branch: task/SL.6-a-fake-runtime-that-asks-for-approval-in
lane: runtimes
executor: claude
---

Proposed by the Slack walkthrough (`docs/reviews/SL-e2e.md`).

Finding. The browser walkthrough cannot show the approval card in a Slack thread, because the fake runtime only echoes. The card path is covered in process only.

Scope. A fake mode chosen by a marker in the task text (for example `ask:<tool>`) that opens an approval request for the run, waits for the answer, and then replies with the decision. It registers only when `devFakeRuntime` is true.

Check. A run test for the mode. Browser: post `@ada ask:send_email` in a linked room, see the card in the fake Slack thread, press Allow once there, and see the request close in Agentum and the card settle.
## Log
- 2026-11-21: added by controller.
- 2026-11-21: dispatched.
- 2026-11-21: ready at 07a0b305, review clean with no fix rounds, browser check passed in the fake Slack thread.
- 2026-11-21: merged cfb162b2, merge check passed. Done.
