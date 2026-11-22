---
id: HM.3
title: "Learned this week stays short"
milestone: HM
size: S
status: done
depends_on: []
branch: null
lane: web-room
executor: claude
---

Dom's screenshots on 2026-11-23, of an agent's task page with the room's side column.

Finding. The side column's "Learned this week" card (`components/agent/room/now/learned-slot.tsx`, placed by `now/index.tsx`) lists every item in full, with no limit and no clamping. An agent with many dream changes makes the side column far taller than the window. The page then scrolls, and the conversation is squeezed into a small box with its own scrollbar, so the chat looks too small.

## Scope

1. Learned this week shows the 3 newest items. Each item's text is clamped to 3 lines. A "Show all (n)" button expands the list in place, and "Show less" folds it again. Undo stays on every item.
2. The side column never makes the page taller than the window on desktop. It scrolls on its own if its content is still taller (`overflow-y-auto` with a max height of the viewport below the header), so the conversation keeps its full height.
3. Phone layout keeps working: the side column stacks as it does today.

## Check

- Component tests: 6 items render 3 plus "Show all (6)", the button expands and folds, clamped text keeps its full text in the DOM or a title, Undo still calls through.
- `bun run check` and the changed packages' tests and build pass.
- Browser at the end pass: a task page for an agent with many learned items at 1440x900 shows the conversation at full height, and at 390x844.

## Log
- 2026-11-23: added by controller from Dom's screenshots.
- 2026-11-23: dispatched.
- 2026-11-23: merged at 8110e46a, review clean after 0 fix rounds. Browser check moved to the end pass.
