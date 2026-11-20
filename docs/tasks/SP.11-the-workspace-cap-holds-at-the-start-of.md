---
id: SP.11
title: "The workspace cap holds at the start of a run"
milestone: SP
size: S
status: in_progress
depends_on: []
branch: task/SP.11-the-workspace-cap-holds-at-the-start-of
lane: services-runs
executor: claude
---

From the SP gate review, round 1 (`docs/reviews/SP-1.md`, must-fix 1).

## Scope

`startRun` and `startForGuest` refuse a new start while the agent's workspace is at or over its weekly cap. The check uses the same week-to-date as `spend.workspaceOver`, team dreams included. It applies to every agent in the workspace, paused or not, so new and restored agents are covered. The follow-ups of work under way stay exempt, the same ones `refuseIfPaused` exempts: `continuationOf`, `wakesParent` and `subagent`. The refusal is the existing `agentPaused` conflict, with a message that names the workspace limit, so every origin's existing handling still applies. With no workspace cap the check costs no query. `spend.resume` is unchanged: it clears the pause, and the start gate decides whether work can begin. The pause card for an agent held by the workspace limit tells a non-admin that only raising the workspace limit lets it run, and drops Resume for them.

## Check

service tests in `spend-caps.test.ts`.

- (a) Workspace cap $1, then a run that costs $1.50. After a plain-member owner's `spend.resume`, `startRun` on that agent is refused with reason `agent_paused`.
- (b) A member creates a new agent while the workspace is over its cap. Its first `startRun` is refused.
- (c) An answer to a parked run (`continuationOf`) and a subagent still start while the workspace is over its cap.
- (d) With no workspace cap, or a cap still above the week, no start is refused.
- (e) After an admin raises the workspace cap above the week, a resumed agent starts.

A component test shows the pause card without Resume for a non-admin while the workspace limit holds the agent. `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-21: added from the SP gate review, round 1.
- 2026-11-21: dispatched on task/SP.11-the-workspace-cap-holds-at-the-start-of (v4 controller session).
