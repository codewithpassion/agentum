---
id: MB.5
title: Mobile: map editor and inspector with touch
milestone: MB
size: M
status: todo
depends_on: [MB.1]
branch: null
lane: web-map
executor: claude
---

Dom asked on 27 Oct 2026 for every function of the app to work from a phone. The audit is `docs/reviews/mobile-audit/report.md`, with screenshots in the same folder; finding ids (F-nn) below refer to it. Target phone sizes: 390x844 and 360x740. Desktop layout (md and up) must not change. Never hand-edit `apps/web/src/components/ui/` (shadcn CLI output): fix at the callers, in a shared wrapper outside `ui/`, or in the global stylesheet.

## Scope

- F-19 (blocker): plugging a tool, skill or computer into an agent works by tap on touch devices: for example tap a palette item to pick it, then tap an agent node (or an "Add to agent" menu on the item). Keep drag and drop on desktop.
- F-20: selecting a node on a phone shows the inspector without scrolling (a bottom sheet or drawer); wires can be made without dragging a tiny handle (for example "Connect to..." in the inspector); "Delete wire" and node "Remove" are reachable 40px controls in the inspector.
- F-18: the map is readable on a phone: a sensible minimum zoom with pan instead of fitting the whole graph into 358px, or a list view toggle that offers the same actions.

## Check

- Each finding in scope is fixed, or the review file says why not.
- A browser check at 390x844 and 1280x800 of every screen touched (agent-browser, local dev server with dev login), screenshots in the review file.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: added from the mobile audit.
