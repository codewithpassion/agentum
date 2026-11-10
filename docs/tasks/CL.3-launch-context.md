---
id: CL.3
title: Build a run's launch context once
milestone: CL
size: M
status: in_progress
depends_on: []
branch: task/CL.3-launch-context
lane: services
executor: claude
---

From the 10 Nov 2026 review. Three runtimes each assemble the run's launch context: `cloud/runtime.ts`, `runs/machine-claim.ts`, `managed/service.ts`.

## Scope

- One `runs/launch-context.ts` builds it, and each adapter maps it to its own shape. No behaviour change.

## Check

- Tests pass before and after. One new test pins the shared context.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-10: added from the 10 Nov review, after Dom's decisions (members are trusted with credentials, the assistant may approve skills, assistant conversations share the thread list and are marked).
- 2026-11-10: dispatched to a Sonnet implementer on task/CL.3-launch-context, after RT.2 merged (it touched managed/service.ts). CL.2 and CL.5 wait for the feature branches.
