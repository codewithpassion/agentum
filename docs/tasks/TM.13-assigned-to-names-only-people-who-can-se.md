---
id: TM.13
title: "'Assigned to' names only people who can see the topic"
milestone: TM
size: S
status: done
depends_on: []
branch: task/TM.13-assigned-to-names-only-people-who-can-se
lane: web-room
executor: claude
---

From the teams walkthrough (`docs/reviews/TM-e2e.md`).

Finding. In a limited topic, a lead post that mentions a person outside the topic still shows "Assigned to Writer Bo, Checker Cy" although Checker Cy is not in the topic and was never woken.

Scope. Where the room builds the assigned list (`room-logic.ts`), keep only mentioned members who are in the topic.

Check. `room-logic.test.ts`: a mention of a non-member is not listed.

## Log
- 2026-11-21: added by controller.
- 2026-11-21: dispatched.
- 2026-11-21: ready at adfd7621, review clean, browser proof passed.
- 2026-11-21: merged e423dd85, merge check passed. Done.
