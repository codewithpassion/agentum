---
id: C.1
title: Pin and wire Pi Durable
milestone: C
size: S
status: done
depends_on: [C.0]
branch: task/C.1-pin-wire-pi
---

From the C.0 spike (`docs/reviews/spike-pi-durable.md`, "Proposed tasks" and the findings above it). Dom said go on all Cloudflare agent tasks on 17 Oct 2026. Read the spike report first. The prototype is in `/home/roboto/devel/harbourmaster-wt/tmp/spike-pi-durable/`, read-only, and code can be lifted from it.

## Scope

Add `agents` 0.28.1, `@earendil-works/pi-durable` and `@earendil-works/pi-ai` at exact versions (no ranges), plus `typebox`. Add the `PI_RUN` Durable Object binding at the top level, `env.staging` and `env.staging.previews` in `apps/web/wrangler.jsonc`, with a new migration tag `v2` (don't edit `v1`). Add a test that pins the tool-result shape pi-durable expects (`output`, not `content`), so a version bump that changes it fails. A minimal `PiRun` class that the next tasks fill in is enough.

## Check

Dry-run bundle (`wrangler deploy --dry-run`) well under the 64 MiB limit, with the size recorded in the review file. The controller deploys to staging afterwards and checks Worker startup under 1 s. `bun run check && bun run test && bun run build` pass, and the bundle grep for `drizzle` passes.

## Log
- 2026-10-17: added from the C.0 spike (Dom: go on all).
- 2026-10-17: dispatched on task/C.1-pin-wire-pi.
- 2026-10-17: review clean after 0 fix rounds at 79513d6 (docs/reviews/tasks/C.1.md). Merged. Dispatcher used tag v3 (M8.1 branch held v2); controller renamed it to v2 on main before deploy, M8.1 takes v3.
