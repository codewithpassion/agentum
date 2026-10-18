---
id: W.2
title: Linux VM keyed by agent with a persistent /workspace/home
milestone: W
size: M
status: done
depends_on: [W.1]
branch: task/W.2-vm-keyed-by-agent
---

Asked for by Dom on 18 Oct 2026, from the report (sections B and D). Files an agent writes in the Linux VM vanish in the next chat because `VmSession` is named by session id (`pi-run.ts` `VM_KEY`, `durable-vm.ts`). Dom chose one VM per agent. Concurrent sessions of one agent share one disk, and the last write wins.

## Scope

- Name `VmSession` by `input.run.agentId` in `pi-run.ts` (`VM_KEY`, `#switchEnvironment`, `#executionEnv`) and `durableVm`.
- Snapshot and restore `/workspace/home` only. `prepareWorkdir` makes `/workspace` first, then restores into `/workspace/home` or makes it empty. The default cwd becomes `/workspace/home`. Skills and input files stay under `/workspace/skills` and `/workspace/input`, so they count as scratch.
- `placeSkills` writes to `/workspace/skills.<runId>` and renames it over the old folder, so a second session never loses skill files mid-call.
- The VM prompt section uses `workspaceInstructions` from W.1. It replaces the sentence in `vm-tools.ts` and drops the contradicting `/library` attachment text for VM sessions.
- The egress intercept stays keyed by the last run that set it. Note the audit gap in the review file. No migration of old per-session snapshots. Dom adds the production R2 lifecycle rule on `vm-snapshots/` before VM agents run there.

## Check

- `vm-core.test.ts` and `vm-workdir.test.ts` cover restore into home, the backup dir, an empty first start, and skills placed while a second run reads them.
- A `pi-run` test shows two sessions of one agent reach the same VM name, and two agents reach different ones.
- Live on staging (controller): a VM agent writes `/workspace/home/note.txt` in chat A, waits over 4 minutes until the VM sleeps and a snapshot object shows in R2, then a new chat B reads the file. `/tmp/x` from chat A is gone in chat B.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-18: added at Dom's request.
- 2026-10-18: dispatched.
- 2026-10-18: review clean after 2 fix rounds at fc1857b (docs/reviews/tasks/W.2.md). Merged. Staging check pending. Dom: production R2 lifecycle rule on vm-snapshots/ before VM agents run there.
