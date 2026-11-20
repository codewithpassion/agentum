---
id: TM.22
title: "A room run never gets private notes"
milestone: TM
size: S
status: in_progress
depends_on: []
branch: task/TM.22-a-room-run-never-gets-private-notes
lane: services-runs
executor: claude
---

From the TM gate review, round 1 (`docs/reviews/TM-1.md`, must-fix 4).

## Scope

- In `runs.ts` `newSessionOwner`, a new session whose origin is shared (`inbox` at least; check `qa` and the Slack origins too) never inherits privacy from a private or `ui` parent run. It belongs to the run's actor and is not private.
- Also make `privateNotesUserOf` return null for origin `inbox`, whatever the session's `private` flag says, so a session already stored as private gets no notes either. Update the module comment.
- A read-only query Dom runs counts inbox sessions with `private = 1` on staging and production. The task file records the count and what to do with them.

## Check

- `inbox.test.ts`: the probe case. A run in u1's `ui` session posts `@beta` into a team topic, and beta's session is not private and `loadPrivateNotesUser` returns null. A second hop from beta's reply gets none either.
- The existing private-notes tests still pass.
- `bun run check && bun run test && bun run build` pass.

## Controller decisions

- The controller runs the read-only count of inbox sessions with private = 1 on staging and production and logs it here.

## Log
- 2026-11-21: added by controller.
- 2026-11-21: dispatched.
