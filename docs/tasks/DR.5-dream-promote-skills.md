---
id: DR.5
title: "Dream promotes repeated procedures to skill proposals"
milestone: DR
size: S
status: todo
depends_on: [DR.4]
branch: null
lane: services-dream
executor: codex
---

From `docs/v4/build-plan.md`, milestone DR. A procedure the agent repeated should become a skill, through the approval flow that exists.

## Scope

- `packages/services/src/dream/steps/promote.ts`: from the collected inputs, find a multi-step procedure the agent ran at least three times. Draft a skill and file it as a proposal through `skills-store` proposals, authored by the agent.
- Skip a procedure that matches a rejected proposal from the inputs.
- The diary lists the proposal. Skill changes always ask, whatever the learn level.

## Check

- Tests with a fake model: proposal filed once, not refiled after a rejection.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
