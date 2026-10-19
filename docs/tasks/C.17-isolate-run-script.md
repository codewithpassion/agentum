---
id: C.17
title: run_script tool for isolate agents, JS and TS in a dynamic worker
milestone: C
size: M
status: done
depends_on: []
branch: task/C.17-isolate-run-script
---

Asked for by Dom on 19 Oct 2026. Isolate agents have no JavaScript or TypeScript runtime: the library shell turns `js-exec` off (`packages/mcp/src/tools/library.ts:44`), and there is no node or bun. An agent on staging said "No JS/TS runtime is available in the sandbox, so I can't execute it here." Skill scripts already run TypeScript in a dynamic worker (C.12, `apps/web/src/server/skill-scripts/run-skill-script.ts`, with `SecretsOutbound`). Dom chose to reuse that path for any script.

## Scope

- A `run_script` tool for isolate runs: either `path` (a `.ts`, `.js` or `.mjs` file in the library) or `code` (inline source, with `language` `ts` or `js`), plus optional `args` (string array) and `stdin` (string). It returns stdout, stderr, exit code and duration, with output capped as the skill-script tool does.
- Build and run it the way skill scripts are built and run: the same TypeScript transform, the same dynamic worker loader, and the same time and memory limits. Share the code with `run-skill-script.ts` rather than copying it. Relative imports between library files work, and so do `https://` imports from a CDN if the skill path already allows them; otherwise say in the tool description that npm packages aren't available.
- Library access from the script: the same small file API skill scripts have (read, write, list under /library), with the agent's usual library rights and Log events.
- Network: follows the agent's C.15 "Network access" setting, through the same fetcher, with C.16 secret placeholders and the same address blocking. With network off, `fetch` inside the script fails with "Network access is off for this agent."
- Log: a `script.run` event with path or "inline", exit code, duration and output sizes. Never the code, args, stdin or output text.
- Agent instructions: in the isolate, the system prompt's workspace section (the W.1 builder) gets a short paragraph saying what the agent can run and how, for example: "You have no shell runtime such as node, bun or python. To run JavaScript or TypeScript, use `run_script` with a library file or inline code. Scripts can read and write the library and, when network access is on, use fetch. npm packages and Node built-ins such as fs and child_process aren't available. For work that needs them, ask for this agent to use the Linux VM." Update the library shell tool's description to point to `run_script` instead of only saying js-exec isn't available. VM and machine agents don't get this paragraph or the tool.

## Check

- Tests: a TS file and inline JS each run and return stdout and the exit code; a relative import between two library files works; a thrown error returns a non-zero exit code and stderr; the time limit stops an endless loop; network off makes fetch fail with the message, and on uses the fetcher with blocking and placeholders; the Log event has no code or output; the isolate prompt contains the paragraph and the VM prompt doesn't.
- `bun run check && bun run test && bun run build` pass.
- Live on staging (controller): an isolate agent writes a small TS file to its home, runs it with `run_script`, and fetches a public URL from a script.

## Log
- 2026-10-19: added at Dom's request. dispatched.
- 2026-10-19: review clean after 1 fix round at 143dec4 (docs/reviews/tasks/C.17.md). Merged. Adds a library global (read, write, list) over an RPC binding. Staging check pending.
