---
id: DR.7
title: "Dream walkthrough"
milestone: DR
size: S
status: todo
depends_on: [DR.5, DR.6]
branch: null
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
