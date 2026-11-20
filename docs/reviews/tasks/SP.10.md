# SP.10 review

## Verdict

Round 0, commit 74f2e07d: clean. No must-fix findings. Browser proof passed at 1280x800 and 390x844, see `SP.10/browser.md`.

## Nits left

- `roster.ts`: the comment above `weekStart` still calls it the Agents overview's rolling week, though the roster shows no cost any more. It now feeds the rail read and the learned count only.
- `agents-table-logic.ts` imports `weekCostLabel` from the roster folder. It sits in `roster-logic.ts` and the spend code already imports it from there.
- A failed `spend.workspace` read gives an empty map, so cards and the table read "$0 this week" until the next poll. Before, a card with no limit kept the roster's figure.
- Home's poll now reads the timezone and a week of spend rows on every tick, not only when a card has a limit.

## Ideas beyond the scope

- `agentsOverview` in `packages/services/src/rail.ts` still computes `costUsdThisWeek` and nothing in the UI reads it. Drop it with its `usage` read.
- In the Agents table, "Tasks this week" still counts a rolling seven days of sessions the viewer can see, while "Cost this week" is now the Monday-to-today workspace week. Move the task count to the spend rows' `tasks` to match.

## Steps for Dom

None.
