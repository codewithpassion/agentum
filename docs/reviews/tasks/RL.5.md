# RL.5: Agents table, Asks on the profile, builder fixes

## Verdicts

- Round 1, at f2bc55c: not clean. Three must-fix: the weekly task count included builder dry runs, the "no per-run cost is stored" comment was false, and a backup-only save sent the creator as owner when the stored owner was null.
- Round 2, at 688499d: not clean. One must-fix: the cost column showed $0 for runs that reported no cost.
- Round 3, at 297522d: clean.

Two fix rounds.

## What was built

- `rail.agentsOverview` in `packages/services/src/rail.ts`, exposed as `agents.overview`. One row per listed agent: `waiting` (open items on a person), `working` (live runs not waiting), `tasksThisWeek`, `costUsdThisWeek`. Counts follow the desk's visibility rules. Dry runs are left out.
- `/agents` is a table: name, who it asks, what it is doing now, tasks this week, cost this week.
- The profile has an Asks row with owner and backup selects, saving through `agents.setOwners`. One member shows plain text. The backup list never offers the owner. Changing the owner to the current backup clears the backup. A backup-only save keeps a null owner null.
- The builder's missing-key error links to `/settings/model-providers`. The description lives in `sessionStorage` (`hm:agent-builder-description`) and clears on create or discard.

## Cost

The spec said to show cost only if it is already stored and cheap to sum. `runs.usage` is JSON text with `costUsd`, written when a run finishes, and one `json_extract` sum per week covers it, so the column is in. It reads "Not reported" when no counted run reported a cost (managed runs and some machine runs never set one). When only some runs reported, the figure is the sum of those.

## Browser check (local dev, Playwright)

Owner change shows on the table. The backup list holds everyone but the owner. Setting the owner to the backup clears the backup. The missing-key error links to Settings, and the description is still there after the trip. Clearing on create could not be driven in the browser because the dev workspace has no Anthropic key, so it is covered by reading the code only.

## Nits left

- `formatCost` in `agents-table-logic.ts` nearly duplicates `costText` in `task-logic.ts` (case and zero differ).
- The one-member branch of the Asks row shows that member even when the agent's owner has left. The table says "Nobody" for the same agent.
- A failed member lookup reads "Unknown" in the table and "Not available" on the profile.
- Changing the owner can clear a backup silently. The toast only says "Saved".
- Saving owners does not dispatch `RAIL_REFRESH_EVENT`, so the rail (RL.3) refreshes on its next poll.
- An agent with only a stuck run in Needs you reads "Quiet" in the table.
- `window.sessionStorage` is touched in `agents.new.tsx` outside the helpers' try/catch, so blocked storage would throw there.
- `isNoKeyError` matches the server message text. Rewording `NO_KEY_MESSAGE` drops the link. Moving the message to `@repo/db/shared` would fix it.
- Only the name is a link in the table, a smaller tap target than the old row.
- The agent list is fetched twice per `/agents` load (loader and overview).
- The compact profile in the map inspector has no Asks row (`members` is optional on `ProfileRows`).

## Ideas beyond scope

- Show "N tasks" and an agent tile in the table, as the design does.
- Dispatch `RAIL_REFRESH_EVENT` after `setOwners`.
- Count stuck runs as "needs you" in the Doing now cell.

## Steps for Dom

None. No new bindings, secrets or migrations. Note for local dev: `apps/web/.env.local` needs `ARTIFACT_VIEW_KEY` (`openssl rand -base64 32`) since the live artifacts work, or the app returns 500.
