---
id: C.9
title: Pi durability suite
milestone: C
size: S
status: done
depends_on: [C.4]
branch: task/C.9-pi-durability-suite
---

From the C.0 spike (`docs/reviews/spike-pi-durable.md`, "Proposed tasks" and the findings above it). Dom said go on all Cloudflare agent tasks on 17 Oct 2026. Read the spike report first. The prototype is in `/home/roboto/devel/harbourmaster-wt/tmp/spike-pi-durable/`, read-only, and code can be lifted from it.

## Scope

Turn the spike's `kill -9` script into a repeatable check (`bun run e2e:pi-durability`) for the safe, unsafe and long-outage cases, and document that it runs on every Pi version bump.

## Check

The script exits 0 on the pinned versions. `bun run check && bun run test && bun run build` pass, and the bundle grep for `drizzle` passes.

## Log
- 2026-10-17: added from the C.0 spike (Dom: go on all).
- 2026-10-17: dispatched on task/C.9-pi-durability-suite.
- 2026-10-17: review clean after 0 fix rounds at 00984a0 (docs/reviews/tasks/C.9.md). Merged. bun run e2e:pi-durability covers unsafe and long-outage cases plus exact pins; safe-tool case moved to C.10.
