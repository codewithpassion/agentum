---
id: C.7
title: Skills and files for cloud runs
milestone: C
size: M
status: done
depends_on: [C.6]
branch: task/C.7-cloud-skills-files
---

From the C.0 spike (`docs/reviews/spike-pi-durable.md`, "Proposed tasks" and the findings above it). Dom said go on all Cloudflare agent tasks on 17 Oct 2026. Read the spike report first. The prototype is in `/home/roboto/devel/harbourmaster-wt/tmp/spike-pi-durable/`, read-only, and code can be lifted from it.

## Scope

Turn the spike's `skills.ts` into product code. Add input file fetch and image blocks, and output files through library upload and `fileIds`, so attachments and `[ATTACHMENT:path]`-style outputs work for cloud agents.

## Check

A run with a seeded skill and an attached image works locally with a live model. The controller repeats it on staging. `bun run check && bun run test && bun run build` pass, and the bundle grep for `drizzle` passes.

## Log
- 2026-10-17: added from the C.0 spike (Dom: go on all).
- 2026-10-17: dispatched on task/C.7-cloud-skills-files.
- 2026-10-17: review clean after 1 fix round at e19335c (docs/reviews/tasks/C.7.md). Merged. Live check passed locally (skill, PNG, text file, output chip). Found: PiRun never passes agent.instructions to Pi.
