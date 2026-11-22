# HM.1 review

Task: Home roster: equal tiles, type-to-search, list view.

## Verdict per round

Round 1, commit 54c9b73f: clean, no must-fix. Zero fix rounds.

## Nits left

- Esc clears the filter wherever focus is, so closing Find or a dialog with Esc also clears it (`roster-wall.tsx`).
- A letter typed in an open menu or listbox (workspace or user menu) opens the search behind it. The guard skips dialogs, not `[role=menu]` or `[role=listbox]`.
- In grouped mode the filter does not expand a collapsed group, so a match inside one stays hidden and the "No agent matches" line does not show.
- List rows use fixed `w-40` and `w-28` columns, and the owner column is hidden below `md`, so a phone shows less than the scope's full row.
- `ACCENT_CLASSES` and the cost expression are copied between `agent-card.tsx` and `agent-row.tsx`.
- Tests do not cover the grouped wall's Add to team tile size, nor view persistence with teams.
- A saved list view shows the grid for one frame on load, because storage is read after mount.

## Beyond scope

- Expand collapsed groups that hold a match while filtering.
- A phone layout for list rows (owner under the name).

## Browser steps skipped

The task's check has none. A browser pass should confirm that the add tiles match the card height in a row with a tall card, that typing opens the field, and that the list toggle survives a reload.

## Steps for Dom

None.
