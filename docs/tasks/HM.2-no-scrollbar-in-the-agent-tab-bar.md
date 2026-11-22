---
id: HM.2
title: "No scrollbar in the agent tab bar"
milestone: HM
size: XS
status: in_progress
depends_on: []
branch: null
lane: web-room
executor: claude
---

Dom's screenshot on 2026-11-23: the agent room's tab bar (Chat, Work, Files, Knows, Keys, Jobs, Settings) shows a vertical scrollbar with up and down arrows at its right end, on a wide desktop window.

Likely cause: `components/agent/room/tab-bar.tsx` sets `overflow-x-auto` on the tablist, and each tab has `-mb-px`. The tabs stick out 1px below the box, and `overflow-x: auto` forces `overflow-y` to auto as well, so a vertical scrollbar appears.

## Scope

The tab bar never shows a scrollbar. On a narrow screen it still scrolls sideways (touch or trackpad), and the selected tab's underline still sits on the bottom border.

## Check

- A component test that the tablist has `overflow-y-hidden` and hides its scrollbar.
- `bun run check` and the changed packages' tests and build pass.

## Log
- 2026-11-23: added by controller from Dom's screenshot.
- 2026-11-23: dispatched.
