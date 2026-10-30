---
id: RL.5
title: "Agents table, Asks on the profile, builder fixes"
milestone: RL
size: S
status: in_progress
depends_on: [RL.2]
branch: task/RL.5-rail-agents
lane: web-agents
executor: claude
---

Spec: `docs/ux-review/rail/spec.md`, the section "Agents and asking (RL.5)" and the Rules. The spec is part of this task and wins over anything else. The clickable design is `docs/ux-review/rail/design.html` (open it with Playwright or read the source, including `?who=dan` and `?scope=everyone`). Why: `docs/ux-review/review.md`.

## Scope
- `routes/_app/agents.index.tsx`, `components/agent/profile/` for the Asks row, and the builder files for the error link and the kept description.
- `rail.agentsOverview` in the service if it's needed, with a test.
- Don't edit `_app.tsx`, `components/shell/`, or `routes/_app/desk.tsx`.

## Check
- Tests: the overview's counts, and that owner and backup selects save and reject a backup equal to the owner.
- Browser check on local dev: change an agent's owner and see it on the table. A description survives a trip to Settings and clears on create. The missing-key error links to Settings.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-30: created from Dom's request to design, spec and build the rail.
- 2026-10-31: dispatched.
