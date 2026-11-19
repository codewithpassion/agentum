---
id: RH.6
title: "Shell: home first, one top bar"
milestone: RH
size: M
status: todo
depends_on: [RH.3, NV.1]
branch: null
lane: web-shell
executor: claude
---

From `docs/v4/build-plan.md`, milestone RH. Global actions sit in a top bar and a rail today. The shell becomes one top bar with home as the first screen.

## Scope

- `routes/_app.tsx`: top bar with the workspace menu, Home, Find, Files, Spend (hidden until `/spend` exists), a Needs you button with a count, New agent, and the user button.
- The Needs you button opens the current rail list as a drawer on every page. `/desk` keeps its item pane and Board and stays in Find.
- Remove the rail footer tabs and the permanent 320px rail. Keep `rail/*` list components for the drawer. Keep the assistant button.
- Phone: the top bar collapses to Home, Needs you and a menu.
- Update `CLAUDE.md` section "The rail" to describe the drawer, and `find-registry.ts` for moved entries.

## Check

- `find-registry.test.ts` passes. Tests for the drawer count.
- Browser: reach every page from the top bar or Find on desktop and phone, answer a request from the drawer.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
