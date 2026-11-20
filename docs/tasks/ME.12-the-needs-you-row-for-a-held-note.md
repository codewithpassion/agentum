---
id: ME.12
title: "The Needs you row for a held note"
milestone: ME
size: S
status: in_progress
depends_on: [ME.9]
branch: task/ME.12-the-needs-you-row-for-a-held-note
lane: services-rail
executor: claude
---

From the ME walkthrough (`docs/reviews/ME-e2e.md`).

In the Needs you drawer a held note shows the agent's sentence twice ("mem-cloud wants to remember something" as the title and again beside the agent tile), and never the note itself. The text only shows on the item page.

## Scope

For `memory_note` rail cards, make the second line the note text (clipped) instead of repeating the heading, in the rail card's status or detail. Keep the heading.

## Check

A rail test for the card fields, and a browser look at the drawer at both sizes.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the ME walkthrough.
- 2026-11-20: dispatched on task/ME.12-the-needs-you-row-for-a-held-note (v4 controller session).
