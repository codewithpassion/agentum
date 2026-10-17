---
id: C.12
title: Run skill TypeScript scripts for cloud agents in a short-lived sandbox
milestone: C
size: L
status: in_progress
depends_on: [C.8, C.11]
branch: task/C.12-cloud-skill-scripts
---

Asked for by Dom on 17 Oct 2026: a skill that ships a TypeScript script should run for cloud agents (Pi in a Durable Object). Today cloud agents can read skill files (C.7) and use library `bash` and Pi's read/write/edit on the library (C.8), but they can't execute code. just-bash runs with JS and Python off. Dom prefers a short-lived sandbox, or something like `cloudflare/computer`.

## Scope

1. Choose the execution backend first, and write the comparison and decision in the review file. Candidates:
   - `cloudflare/computer` (https://github.com/cloudflare/computer): filesystem, runtime and session lifecycle APIs, with a shell that runs inside a Dynamic Worker.
   - The Cloudflare Sandbox SDK (`@cloudflare/sandbox`, https://github.com/cloudflare/sandbox-sdk): a container per sandbox, with bun or node available, made short-lived with sleep or destroy after the run.
   - A Dynamic Worker (Worker Loader) that runs the transpiled script as an isolate.
   
   Compare them on: running a `.ts` file that imports only its own skill files and standard APIs, start-up time, cost, limits, network control (off by default), local dev support (`vite dev` / `wrangler dev`; Docker is available on this machine), and the effect on our bundle and `wrangler.jsonc`. Prefer short-lived: one sandbox per run, destroyed or put to sleep when the run ends.
2. Add a Pi tool for cloud agents, such as `run_skill_script(skill, path, args)`. It puts the skill's files into the sandbox, runs the script with a time and output cap, and returns stdout, stderr and the exit code. Network is off unless the backend can't do that, in which case say so. The skill guidance tells cloud agents to use it for `.ts` files.
3. Bindings and config in all three places in `wrangler.jsonc` (top level, `env.staging`, `env.staging.previews`), with a new Durable Object or container migration tag after `v3` if one is needed. Update the agent form's notes for cloud agents.

## Check

Unit tests for the tool with the backend behind a port and a fake behind it: file placement, the time cap, the output cap, a non-zero exit. Live on a local dev server, with `ANTHROPIC_API_KEY` from `apps/web/.env.local` stored as the workspace key in the local dev database: a cloud agent with a skill `ts-hello` (`SKILL.md` plus `scripts/hello.ts`, which prints a codeword computed at run time from its argument) runs the script and replies with the codeword. A script that tries `fetch("https://example.com")` fails or is blocked, as the decision says. The controller repeats the live check on staging after deploy. `bun run check && bun run test && bun run build` pass, and the bundle grep for `drizzle` passes.

## Log
- 2026-10-17: added at Dom's request; dispatched on task/C.12-cloud-skill-scripts.
