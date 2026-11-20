---
id: NV.6
title: "Runtime names on the task page and in the builder"
milestone: NV
size: S
status: in_progress
depends_on: [RH.5]
branch: task/NV.6-runtime-names-task-page
lane: web-thread
executor: claude
---

From the NV gate review, round 2 (`docs/reviews/NV-2.md`, finding 1 with findings 2 and 5 folded in). This is the second and last NV gate round, so NV closes when this task merges, without a third gate. The files sit in `web-thread` (`task-logic.ts`), `web-builder` and `web-agent`.


## Scope

- `components/task/task-logic.ts`: build `RUNTIME_LABELS` from `RUNTIME_NAMES` in `components/agent/profile/profile-logic.ts`, so the header reads "Cloud", "Anthropic cloud" or "My computer" when the machine has no name. Name `fake` "Test runner", as the Map does.
- `builder/start-blank.tsx` and `builder/draft-card.tsx`: replace "No runtime is available." with wording that does not say "runtime", for example "Nowhere to run it yet. Add an Anthropic API key or a machine in Settings."
- Finding 2: replace "machine agent(s)" with "agents on My computer" in `runtime-notes.tsx`, `sheets/secrets.tsx` and `connections-logic.ts`.
- Optionally do the same for `map-logic.ts` `RUNTIME_SHORT` (finding 5), keeping its strings as they are.
- Labels only. Stored values, routes, tRPC and server code stay as they are.

## Check

- This grep finds nothing outside tests and code comments: `grep -rnE "Managed agent|\"A machine\"|Fake runtime|No runtime|[Mm]achine agents?\b|machine and Linux" apps/web/src/components apps/web/src/routes --include=*.ts --include=*.tsx`. On 3ea29fa3 it hits the sites in findings 1 and 2, plus the comment at `move-agent-dialog.tsx:59`.
- `task-logic.test.ts` asserts `runsOnText` for `managed` ("Anthropic cloud"), for `machine` with no machine ("My computer") and for `cloud` ("Cloud").
- Browser: open a task of an Anthropic cloud agent at desktop width, and the header line says "Anthropic cloud". In a workspace with no Anthropic key and no machine, open Start blank and read the new line under "Runs on".
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the NV gate review, round 2 (one must-fix).
- 2026-11-20: waits for RH.5, which holds the web-agent lane these notes live in.
- 2026-11-20: dispatched on task/NV.6-runtime-names-task-page (v4 controller session).
