---
id: KY.7
title: "Keys walkthrough"
milestone: KY
size: S
status: done
depends_on: [KY.2, KY.4, KY.5, KY.6]
branch: task/KY.7-keys-e2e
lane: e2e
executor: claude
---

From `docs/v4/build-plan.md`, milestone KY. End-to-end check for KY.

## Scope

- Walk through: admin adds an app from the catalogue, assigns it on an agent's Keys tab, a member connects their own account, the agent uses the tool in a task with the fake runtime.
- Findings to `docs/reviews/KY-e2e.md`.

## Check

- The walkthrough passes on local.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/KY.7-keys-e2e (v4 controller session).
- 2026-11-20: merged as 6f373ae5, review clean after 1 fix round. Walkthrough: docs/reviews/KY-e2e.md; browser proof docs/reviews/tasks/KY.7/browser.md passed every flow except two carried to tasks: the tool-call step (the fake runtime can't call tools; proved by curl, KY.9) and the task page's phone overflow (handed to RH.6). check, test and build passed on main. Follow-ups KY.9 to KY.12 added.
