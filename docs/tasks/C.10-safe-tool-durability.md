---
id: C.10
title: Safe-tool case for the Pi durability suite
milestone: C
size: S
status: in_progress
depends_on: [C.9]
branch: task/C.10-safe-tool-durability
---

From C.9's review (`docs/reviews/tasks/C.9.md`). The suite has no safe-tool case, because no tool the faux model can call is both read-only and slow.

## Scope

Add what C.9 names: a dev-only faux prompt and a read-only tool that sleeps, available only in local dev and tests (never in a deployed build). Then add the safe case to `bun run e2e:pi-durability`: kill the dev server during the slow read-only call and check that the call runs again after recovery and the run ends `done`.

## Check

`bun run e2e:pi-durability` covers all three cases and exits 0. A test or build check shows the dev-only tool isn't registered in a production build. `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-17: added from C.9's review. Starts after C.5 and C.6 merge, since it touches PiRun tool wiring.
- 2026-10-17: dispatched on task/C.10-safe-tool-durability.
