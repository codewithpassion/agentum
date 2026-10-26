---
id: X.8
title: Escalate fallback for investigator runs that finish without reporting
milestone: X
size: S
status: done
depends_on: []
branch: task/X.8-investigator-done-fallback
lane: services
executor: claude
---

Found by X.4's staging check on 26 Oct 2026. X.3 added a server-side escalate fallback that posts one `investigation.result` (contract C3) when an investigator run fails or is cancelled. A run that finishes `done` without having posted a result gets nothing: staging run 01M5VJJKTQBEXJQ6G6B0D113D4 ended after a denied approval and control-plane never heard back.

## Scope

- When a run started by an investigator trigger ends `done` and no `investigation.result` was posted for it, post the same escalate fallback X.3 posts for failed and cancelled runs. Keep the C3 shape exactly as in `~/devel/ai-os-integration/CONTRACTS.md`.
- Still exactly one `investigation.result` per run: a run that did report gets no fallback.

## Check

- Unit tests: done without a report posts one escalate; done after a report posts nothing; failed and cancelled behave as before.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-26: added from X.4's staging check.
- 2026-10-26: dispatched.
- 2026-10-26: review clean after 0 fix rounds; merged and deployed to staging.
