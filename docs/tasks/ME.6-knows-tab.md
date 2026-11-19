---
id: ME.6
title: "Knows tab: notes, rules, learned this week"
milestone: ME
size: M
status: todo
depends_on: [ME.1, RH.4]
branch: null
lane: web-knows
executor: claude
---

From `docs/v4/build-plan.md`, milestone ME. Mockup: section "Memory and dreaming" in the report.

## Scope

- Build in `components/agent/room/knows/`. Left: notes grouped by kind, each with its source link and date, Edit and Forget. Below: skills and instructions, reusing the existing components.
- Right: Remember and Never remember lists (workspace rules shown as locked rows), the three learn levels, the Shares with team switch.
- Learned this week: `memory.changes` for seven days, with Undo per change. Fill the slot in the Right now panel from RH.5.
- Held notes show Approve and Reject inline.
- Leave a marked empty area at the top for the dream card (DR.6).

## Check

- Component tests for grouping, locked workspace rules, held note actions.
- Browser: add a note by hand, edit it, forget it, change the learn level as owner, see a member cannot change rules.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
