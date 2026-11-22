---
id: HM.1
title: "Home roster: equal tiles, type-to-search, list view"
milestone: HM
size: S
status: in_progress
depends_on: []
branch: null
lane: web-roster
executor: claude
---

Dom's small fixes for the agent wall on Home (`components/roster/roster-wall.tsx`), from a screenshot on 2026-11-23.

## Scope

1. The "New agent" and "Start from a template" tiles are the same height and width as an agent card. Today they are shorter.
2. Filter agents by name. Typing anywhere on Home (when focus is not in an input, textarea or contenteditable, and no modifier key is held) opens a search field with that first character and filters the cards by agent name, case-insensitive. Esc clears the filter and closes the field. With no match, say so in one line. The Needs you chips stay as they are.
3. A list view. A toggle switches between the card grid and a compact list (one row per agent: avatar, name, status dot, current activity, owner, cost this week). The choice is remembered per browser in localStorage, wrapped in try/catch. The filter applies to both views. The New agent and template actions stay reachable in list view.

## Check

- Component tests in `roster-wall.test.tsx`: tiles get the card's size classes, typing a letter opens and fills the filter, Esc clears it, typing inside an input does not open it, the list toggle renders rows and persists.
- `bun run check` and the changed packages' tests and build pass.

## Log
- 2026-11-23: added by controller from Dom's request.
- 2026-11-23: dispatched.
