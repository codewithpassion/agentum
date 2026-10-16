---
id: S.1
title: Daemon syncs an agent's skills into its work directory
milestone: S
size: S
status: done
depends_on: [F.1, M1.6, M1.9]
branch: task/S.1-daemon-skills-sync
---

From the just-bash spike (`harbourmaster-wt/tmp/spike-just-bash/REPORT.md`). Draft, not approved.

## Scope

Skills live in the library at `/skills/<agentId>/<skill>/SKILL.md`, with any helper files next to it. `/skills/_shared/<skill>/` holds skills every agent in the workspace gets; an agent's own skill of the same name wins.

A run-token route `GET /api/runs/:id/skills` returns the file list (path, size, etag) for the run's agent, and `GET /api/runs/:id/skills/file?path=` returns one file. Caps: 200 files and 5 MB per agent.

The daemon fetches the list after `prepareWorkDir` (which already empties `.claude/`) and before `buildOptions`, and writes each file to `<workDir>/.claude/skills/<skill>/...`. It uses `WorkFiles.write`, so on hm-agent machines the files go through the existing `dd` sudo rule and end up owned by hm-agent, and on single-user machines plain `node:fs`. `settingSources: ["project"]` already makes Claude Code load `.claude/skills/`, so the SDK options do not change. A failed sync logs a warning event and the run goes ahead without skills.

## Check

A daemon test with a fake run API: two agent skills and one shared skill land under `.claude/skills/` in both modes (the multi-user one through the fake command runner), a leftover skill from the previous run is gone, a path with `..` is refused. A service test: a run token reads only its own agent's and `_shared` skills. Live in local dev with a real Claude Code agent: put `/skills/<agent>/shout/SKILL.md` ("when asked to shout, answer in capitals") in the library, start a run with "shout hello", and the reply is in capitals.

## Log
- 2026-10-16: drafted from the just-bash spike.
- 2026-10-16: added from the just-bash spike (docs/reviews/spike-just-bash.md). Dom accepted the defaults: library in Harbourmaster on R2, agents write anywhere, agents may edit their own skills, paid Workers plan, 10 MB per file and 1 GB per workspace, just-bash beta with network, Python and JS off.
- 2026-10-16: dispatched on task/S.1-daemon-skills-sync.
- 2026-10-16: review clean after 0 fix rounds at 04b0c31 (docs/reviews/tasks/S.1.md). Merged. hm-agent ownership check left for Dom.
