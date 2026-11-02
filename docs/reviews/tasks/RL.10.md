# RL.10 review: Board, Find and New move to the top bar

Branch task/RL.10-header-actions.

## What changed

Board, Find and New now sit at the right of the top bar, before the user button, in that order. The header has a second slot (`HeaderActionsSlot`, only in the app shell), and `Rail` portals `RailHeaderActions` into it from outside `<Sidebar>`, so the controls stay on screen while the phone sheet is closed. Board is a link to `/desk?view=board` with the `Kanban` icon and is `aria-current` on that view. Below `md` the three show icons only, with `aria-label`s. The rail header keeps the workspace name on its own row, plus the scope toggle. The footer `Everything` button and Ctrl/Cmd+K still open Find.

The New menu is a panel anchored under its button. It closes on Escape and on an outside press, and ignores both while the dialog is open. For that, `NewTaskDialog` gained an optional `onOpenChange` prop. `RailLink` gained an optional `label` (the `aria-label`). Spec lines in `docs/ux-review/rail/spec.md` updated.

## Verdicts

- Round 1 (017ec60): clean.

## Browser check

Dev login, Vite on port 5311, headless Chrome. Screenshots in `/home/roboto/devel/harbourmaster-wt/tmp/RL.10/`: `before-*` and `after-*` at 1280 and 360, light and dark, plus `after-new-menu-*`, `after-new-task-dialog.png`, `after-360-sheet.png`.

- Board opens `/desk?view=board` from `/agents`, and has `aria-current="true"` there.
- Find opens from the bar, from Ctrl+K and from the footer `Everything`.
- New opens the menu. Escape and an outside click close it. The dialog opens from the menu and the menu stays mounted while it is open.
- At 360px the page has no horizontal overflow. The header wraps to two rows there (the user button and theme toggle drop under the title).
- The rail shows the full workspace name ("Dev Workspace") on its own row.
- Starting a task from New was not run end to end: the local database has no agents, so the dialog shows "Create an agent first.". The started path (`handleStarted`) is unchanged apart from also clearing the dialog state.

## `useIsFullBleed`

The only full-bleed routes are `/a/$artifactId` and `/s/$token`. Both are top-level routes outside `_app`, so they have no rail and lose nothing. No route inside `_app` hides the header.

## Nits left

- A successful submit in `NewTaskDialog` calls `setOpen(false)` without `onOpenChange`; `RailNewMenu` clears its own state in `handleStarted`.
- At 360px the header is about 104px tall against 64px before. The theme toggle's "Dark" label pushes it onto a second row.
- `HeaderActionsSlot` has no `empty:hidden`, so before hydration the empty div takes a flex gap, and the header shifts when the controls arrive.
- The `aria-current` test covers the pure `isBoardView`, not a render on the board URL.
- The New button has no `aria-haspopup` or `aria-controls`, and focus does not move into the menu or back on Escape.
- The icon-only buttons have `aria-label` but no `title`.
- Dropping `data-icon="inline-start"` from the buttons loses the tighter left padding from `md` up.
- Escape inside the dialog closes the dialog and then the menu.
- `guest-execution.test.ts` failed in one run, with a Miniflare `fetch failed` / `ECONNRESET` (also for the reviewer, in isolation). It passed in the full run (3958 pass, 0 fail). It touches nothing in this diff.

## Ideas beyond the scope

- Hide the theme toggle label below `sm` so the header stays on one row at 360px.
- Move the theme toggle into the user menu.

## Steps for Dom

None.
