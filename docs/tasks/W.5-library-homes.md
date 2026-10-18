---
id: W.5
title: Isolate and managed homes in the library, prompts for both
milestone: W
size: S
status: todo
depends_on: [W.1]
branch: task/W.5-library-homes
---

Asked for by Dom on 18 Oct 2026, from the report (section D). Isolate and Managed Agents have no private folder. Dom chose a library folder, `/library/agents/<slug>/`, for both, and not an Anthropic memory store. The folder is a convention only: any member may still write there, and `canWriteAt` stays as it is.

## Scope

- Before a run, `PiRun` (isolate) and the managed service call `library.mkdir` for `agents/<slug>/` when it is missing.
- The isolate passes that folder as the `cwd` of `createLibraryEnv`, so relative writes land there.
- Prompts use `workspaceInstructions` from W.1. It replaces `library-tools.ts:15` and the isolate attachment text, and is added to the managed `systemOf`. Isolate scratch says there is none, and that files the bash tool writes outside `/library` last for one call. Managed home says it is reached with the library tools, and scratch is the session's own disk.
- A renamed agent leaves its old folder behind. Say so in the review file and do nothing about it.

## Check

- `library-tools.test.ts` and `managed.test.ts` assert the prompt names the agent's folder. A run on an agent with no folder creates it once, and a second run does not create it again.
- Live on staging (controller): an isolate agent and a Managed Agent each write a note in chat A, and read it in a new chat B.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-18: added at Dom's request.
