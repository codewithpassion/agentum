---
id: C.18
title: Keep a script's output when it hits its time limit
milestone: C
size: S
status: in_progress
depends_on: []
branch: task/C.18-script-timeout-output
---

Asked for by Dom on 19 Oct 2026. In the C.17 staging check, a `run_script` run (94TVF8QX, 60 fetches) hung until the 30 s limit and ended with exit code 124 and only "timed out after 30 s" on stderr. Every line it had printed was lost. Three reruns finished in about 4.5 s, so the hang wasn't reproduced.

## Scope

- When `run_script` or a skill script stops at its time limit, return the stdout and stderr printed so far, followed by the timeout line on stderr, with the same output caps. Stream or buffer the script's console output in the harness so it survives the abort.
- Look for why that run hung: a fetch that never settles after the 50-subrequest limit, or a promise left pending. If a cause is found and is small, fix it; otherwise note it in the review file.

## Check

- Tests: a script that prints three lines and then loops past the limit returns those three lines and the timeout line, with exit code 124; the same for a skill script.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-19: added at Dom's request. dispatched.
