---
id: W.6
title: Machine scratch folder and prompt
milestone: W
size: S
status: in_progress
depends_on: [W.1]
branch: task/W.6-machine-scratch
---

Asked for by Dom on 18 Oct 2026, from the report (section D, "Machines"). The machine work dir already persists per agent per machine, but the prompt does not say so and there is no scratch folder (`apps/daemon/src/workdir.ts`, `executor.ts:278-282`).

## Scope

- `prepareWorkDir` also empties `tmp/` before each run, in single-user and multi-user mode. Other files stay.
- The daemon's `systemPrompt.append` uses `workspaceInstructions` with home = the work dir, scratch = `<workDir>/tmp`, and the library reached through the platform MCP server.

## Check

- `workdir.test.ts`: both modes empty `tmp/` and keep other files. `executor.test.ts`: the append names home, scratch and library.
- Live on staging (controller): a machine agent keeps a file in its work dir across two chats, and a file in `tmp/` is gone in the second.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-18: added at Dom's request.
- 2026-10-18: dispatched.
