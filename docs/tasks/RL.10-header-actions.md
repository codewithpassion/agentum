---
id: RL.10
title: "Board, Find and New move to the top bar"
milestone: RL
size: S
status: done
depends_on: []
branch: task/RL.10-header-actions
lane: web
executor: claude
---

Dom's request, 2 November 2026: the board matters but is buried in the Find overlay, and the top of the rail is too crowded. The workspace name truncates to "Harbour Edge Int..." beside Find and New. Move Find and New to the top bar where "Harbourmaster" sits, along with a new button for the board.

## Decisions
- The three controls stay together on the right of the top bar, before the user button, in the order Board, Find, New.
- Board is a link to `/desk?view=board` with the `Kanban` icon that its Find entry uses, marked `aria-current` on that view. The Find entry and the `N done today` link both stay.
- The rail header keeps the workspace name, on its own row with room for the full name, and the scope toggle.
- The footer `Everything` button and Ctrl/Cmd+K still open Find.
- Below `md`, Board, Find and New show icons only, with `aria-label`s. The header must not overflow at 360px wide.

## Scope
- `apps/web/src/components/header.tsx`: add a second slot, shown only `inAppShell`, as the first child of the right-hand group.
- `apps/web/src/components/shell/header-menu-slot.tsx`: export the new slot id and a portal component, sharing the lookup with `HeaderMenuButton`.
- `apps/web/src/components/rail/rail.tsx`: portal the controls into the slot, rendered outside `<Sidebar>` beside `FindDialog`, so they stay on screen while the phone sheet is closed. The Find state can stay in `Rail`.
- `apps/web/src/components/rail/rail-new-menu.tsx`: the menu is an inline panel because `NewTaskDialog` carries its own trigger and a popover would unmount it as the dialog opens. A `basis-full` panel can't live in a fixed-height header, so anchor it absolutely under the button and keep `NewTaskDialog` mounted. It closes on Escape and on an outside click, but not while the dialog is open.
- `docs/ux-review/rail/spec.md`: update lines 140 and 144 to match.

## Check
- A test that the header slot renders only inside the app shell, and one for Board's `aria-current`.
- `find-registry.test.ts` still passes.
- Browser, at 1280px and 360px, in dark and light: Board opens the board from any page, Find opens from the bar, the footer and the shortcut, New opens New task and New agent and a task can be started from it, and the rail shows the full workspace name. Attach before and after screenshots under `/home/roboto/devel/harbourmaster-wt/tmp/RL.10/`.
- Check `useIsFullBleed`: a route inside `_app` that hides the header would lose these controls. Report any you find.
- `bun run check && bun run test && bun run build`, and the grep of `apps/web/dist/client` for `drizzle` finds nothing.

## Log
- 2026-11-02: created from Dom's request.
- 2026-11-02: dispatched.
- 2026-11-02: review clean after 0 fix rounds. Merged and pushed. Starting a task from New was not run end to end, because the local database has no agents. Check it on staging.
- 2026-11-02: deployed to staging at c222660d. Board and a task started from New both checked in the browser there. Production not deployed.
