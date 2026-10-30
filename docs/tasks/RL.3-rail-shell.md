---
id: RL.3
title: "The rail replaces the sidebar, with Find"
milestone: RL
size: M
status: done
depends_on: [RL.2]
branch: task/RL.3-rail-shell
lane: web-shell
executor: claude
---

Spec: `docs/ux-review/rail/spec.md`, the section "The shell (RL.3)" and the Rules. The spec is part of this task and wins over anything else. The clickable design is `docs/ux-review/rail/design.html` (open it with Playwright or read the source, including `?who=dan` and `?scope=everyone`). Why: `docs/ux-review/review.md`.

## Scope
- `apps/web/src/components/rail/`, `_app.tsx`, and removal of what the old sidebar leaves unused. Only this task edits `_app.tsx` and `components/shell/`.
- `useRail`, `stableOrder`, the Mine and Everyone toggle, setup rows, the expandable Working list, the foot links, New menu and Find.
- Links point at `/desk?item=<id>` and `/desk?view=board`. RL.4 builds those. Until it merges they land on the current Desk, which is fine.
- Don't change `routes/_app/desk.tsx` or anything in `components/desk/`.

## Check
- Tests: `stableOrder` keeps the open row in place with new rows arriving above and below it. The Find list covers every route under `routes/_app/` (say which are excluded and why, such as dynamic routes).
- Browser check on local dev at 1440x900 and 390x844: the rail renders with seeded agents, Find opens with Ctrl+K, and the mobile sheet opens. Touch targets are at least 40px at 390px.
- After `bun run build`, grep `apps/web/dist/client` for `drizzle` finds nothing.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-30: created from Dom's request to design, spec and build the rail.
- 2026-10-31: dispatched.
- 2026-10-31: merged, review clean.
