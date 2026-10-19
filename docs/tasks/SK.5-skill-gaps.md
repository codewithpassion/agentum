---
id: SK.5
title: Skill and connector delete, owner auto-assign, version numbers in the Log
milestone: SK
size: M
status: blocked
depends_on: []
branch: task/SK.5-skill-gaps
---

Backlog: Dom agreed on 19 Oct 2026 to collect these here. Blocked so it isn't dispatched until Dom says start.

Gaps from the SK staging check on 18 Oct 2026 and the P.5 trial on 19 Oct 2026:
- A skill an agent creates isn't assigned to that agent, and agents can't assign, so a person has to assign it before the agent can use even the approved version.
- Skills can't be deleted in the UI or through MCP. Test skills `sk-check`, `sk-agent` and `p5-loop` are left on staging.
- Connectors can't be deleted either. The test connector `p5-stub` is left on staging.
- Skill entries in the Log show only the skill name, not the version number.

## Scope

- Assign an agent-created skill to its owning agent automatically, taking effect once a version is approved.
- Delete a skill (people only, in the UI and an MCP tool): removes its versions, files and assignments, and its R2 blobs when no other version uses them. Refuse while a run is using it, or explain what happens to running agents.
- Delete a connector (people only, in the UI and an MCP tool): removes its stored credentials and its assignments to agents.
- Show the version number in skill Log entries.

## Check

- Tests for each item. Browser check of both deletes. `bun run check && bun run test && bun run build` pass.
- Live on staging (controller): delete `sk-check`, `sk-agent`, `p5-loop` and `p5-stub`.

## Log
- 2026-10-19: added at Dom's request, backlog.
