---
id: TX.8
title: "A refused hand-off wake is retried"
milestone: TX
size: S
status: todo
depends_on: []
branch: null
lane: services-inbox
executor: claude
---

From the team extras walkthrough (`docs/reviews/TX-e2e.md`).

Finding. The hand-off request is posted in the Team diary topic and the lead is woken. When the lead has used its 10 wakes for the hour, the wake is refused with an `inbox.loop_stopped` event (reason `budget`) and nobody ever tells the lead. The dream's own diary still says "The lead was asked to propose a change", and the Team diary post sits unanswered. It happened here after about ten fake-runtime posts in an hour. A real lead on a busy team could meet it too.

Scope. When the wake for a hand-off request is refused, retry it on a later tick (the hand-off post is the record: wake the lead when it has no run after the post and the budget allows). The dream's diary is written before any retry, so word its line as "asked the lead" for the request and leave out any claim that the lead is working on it.

Check. A service test with a lead at its wake limit: the post exists, no run starts, a later tick after the window starts it once. Browser: the lead answers in Team diary.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-21: added by controller from the TX walkthrough.
