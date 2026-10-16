---
id: C.3
title: PiRun Durable Object
milestone: C
size: L
status: in_progress
depends_on: [C.2]
branch: task/C.3-pirun-do
---

From the C.0 spike (`docs/reviews/spike-pi-durable.md`, "Proposed tasks" and the findings above it). Dom said go on all Cloudflare agent tasks on 17 Oct 2026. Read the spike report first. The prototype is in `/home/roboto/devel/harbourmaster-wt/tmp/spike-pi-durable/`, read-only, and code can be lifted from it.

## Scope

`PiRun` Durable Object keyed by session. Event translation sliced per run, serial flush (Pi events aren't safe under concurrent callers), complete and fail with the model's error text, usage mapping, cancel, and steer for a second message in a busy session. Runs write into the existing run lifecycle, events and transcript, so Sessions, Log, Slack, inbox, triggers and routines work unchanged.

## Check

Faux-provider tests under `wrangler dev`: two runs in one session, duplicate dispatch, abort, model failure. No duplicate `seq` rows. `bun run check && bun run test && bun run build` pass, and the bundle grep for `drizzle` passes.

## Log
- 2026-10-17: added from the C.0 spike (Dom: go on all).
- 2026-10-17: dispatched on task/C.3-pirun-do.
