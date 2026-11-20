---
id: DR.7
title: "Dream walkthrough"
milestone: DR
size: S
status: done
depends_on: [DR.5, DR.6]
branch: task/DR.7-dream-e2e
lane: e2e
executor: claude
---

From `docs/v4/build-plan.md`, milestone DR. End-to-end check for DR.

## Scope

- Seed an agent with ten conversations that hold one correction, one duplicate fact and one contradiction. Run Dream now. Check the diary, the notes, the question in Needs you, and Undo.
- Run once with a real model on local if a workspace key is set, and note the cost.
- Findings to `docs/reviews/DR-e2e.md`.

## Check

- The walkthrough passes on local.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/DR.7-dream-e2e (v4 controller session).
- 2026-11-21: merged as 356051c0, review clean after 1 fix round. Walkthrough passed at both sizes: docs/reviews/DR-e2e.md, docs/reviews/tasks/DR.7/browser.md. Real-model run cost $0.008 for 8 dreams. check, test and build passed on main. Follow-ups DR.9 to DR.13.
