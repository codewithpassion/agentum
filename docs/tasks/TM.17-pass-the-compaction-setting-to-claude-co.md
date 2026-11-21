---
id: TM.17
title: "Pass the compaction setting to Claude Code on machines"
milestone: TM
size: S
status: ready
depends_on: []
branch: task/TM.17-pass-the-compaction-setting-to-claude-co
lane: daemon
executor: claude
---

From the teams walkthrough (`docs/reviews/TM-e2e.md`).

Finding. Claude Code 2.1.327 has `--autocompact <auto|tokens>` (at least 100k tokens). The client passes only `--effort`, so the agent's context budget (TM.5: 100k, 200k, 500k) does nothing on machine runs.

## Scope

In `apps/agentum/src/claude.rs`, pass `--autocompact <tokens>` from the run's context budget when `claude --version` is at least 2.1.327, and leave it out below that. Read the version once per daemon start, not per run.

## Check

- Rust tests: the flag is passed at 2.1.327 and above, left out below, and left out when the version can't be read.
- `bun run check && bun run test && bun run build` pass, including agentum-rs tests.

## Log
- 2026-11-21: added by controller.
- 2026-11-21: dispatched.
- 2026-11-21: ready at 25168032, review clean with no fix rounds. Flag confirmed with claude --help on 2.1.327.
