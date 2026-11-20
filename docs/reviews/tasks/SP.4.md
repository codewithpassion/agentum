# SP.4 review

Task: Spend page, cap field and card line. Built by Haiku workers, reviewed by Opus.

## Verdicts

- Round 1 (e19bbc35): must-fix, three items. The workspace limit line on the chart was dropped by recharts whenever spend was below the limit (`ifOverflow` was missing). "Raise the limit" on the pause card set an agent cap even when the workspace limit caused the pause. The Home card counted "this week" as the last seven days while the limit counts Monday weeks in the workspace timezone.
- Fix (14f53995): the chart line uses `ifOverflow="extendDomain"`. The pause card reads the workspace's week total and, at or over the workspace limit, replaces Raise with a link to `/settings/spend`. Home gives cards that have a limit the Monday-week spend from `spend.workspace` (`withLimitWeekSpend`).
- Round 2 (14f53995): must-fix, one item. `roster.ts` hard-coded `weeklyCapCents: null`, so no card ever had a limit.
- Fix (e140d482): `roster.ts` passes the agent row's `weeklyCapCents` through. SP.3 makes the same one-line change, so the merge is clean.
- Round 3 (e140d482, fix commit only): clean.

## Browser proof

`docs/reviews/tasks/SP.4/browser.md`, verdict PASS at 1280x800 and 390x844. SP.3 had not merged when the proof ran, so it ran on a scratch checkout of this branch with SP.3's head (bea7ffa7) merged in, because the pause and resume flows need SP.3's `setCap`, `resume` and `caps`. The scratch checkout is gone. Usage was seeded into local D1, since the fake runtime reports no cost. The one console error and non-2xx response is the 409 from starting a task on a paused agent, which is the designed refusal.

## Decisions

- Week boundaries are computed in the browser from the workspace timezone (`spend-logic.ts`) with the same method as `mondayWeekStart` in `spend-rollups.ts`. The page reads `spend.workspace` once for five weeks.
- The chart is one series (workspace spend per week), one axis, no legend, this week in full colour and earlier weeks lighter, a dashed line for the workspace limit. The table beside it is the text view and carries the per-agent figures.
- An agent with a limit or a pause shows in the table before it spends, so its limit is visible.
- The header and the card say "$X of $Y this week" only when a limit is set. Without one they show the old plain figure (card) or nothing (header).
- The agent limit field shows to every member and the workspace field to org admins only. The server decides who may save (SP.3: the agent's owner or an org admin for an agent, an org admin for the workspace) and its message shows under the field.

## Nits left

- `spend-pause-card.tsx`: when both the agent's limit and the workspace limit are reached, only the workspace link shows, and the agent's own Raise is hidden.
- `spend-pause-card.tsx`: until the three loads (caps, timezone, workspace rows) finish, "Raise the limit" can be clicked, and in the workspace-limit case it would set an agent cap.
- The week lookup (timezone, then `spendWeeks(...).at(-1)`, then a spend read) is repeated in the pause card, `home.tsx` and `agents.$agentId.tsx`. One shared helper would cover them.
- On Home, a card with a limit counts "this week" from Monday and a card without one counts the last seven days. Both say "this week".
- On a phone the `/spend` table scrolls sideways inside its own box, so "This week" and "Limit" start off-screen and the agent column is not sticky.
- A zero week shows "$0" where other cells show "$x.xx" (`weekCostLabel`).
- Raise the limit prefills the current limit, and submitting it unchanged resumes the agent with the same limit.
- No roster test sets an agent limit and checks it reaches the card. The pause-card check that decides the workspace limit caused the pause has no test, only the view with `workspaceLimitText` already set.

## Ideas beyond scope

- Make the roster's `costThisWeekCents` count the Monday week in the workspace timezone and include dream cost, so `withLimitWeekSpend` can go (RH.2 and SP.2 territory).
- Show tasks per agent on `/spend`. The rollup already carries `tasks`.

## Steps for Dom

None. Migration 0056 from SP.1 must be on staging and production before this ships.
