# SP.2 review

Task: spend rollups from run usage. Implemented in Codex, reviewed by Opus.

## Verdicts

- Round 1 (2d42128f): must-fix. `rail.agentsOverview`, which feeds the Agents table cost, still summed `json_extract(usage, '$.costUsd')` in SQL, so two cost readers existed.
- Fix (7267d6d4): `reportedCostOf` and `costOf` live in `packages/services/src/usage-cost.ts`. Roster, spend and `agentsOverview` all read cost through them. `agentsOverview` now sums in JS and keeps null for "no run reported a cost". Malformed usage JSON no longer errors the query.
- Round 2 (7267d6d4, fix commit only): clean.

## Decisions made in the brief

- A run counts on the day of `createdAt`, a dream on `startedAt`, in the workspace timezone. Cents are summed per agent-day and rounded once.
- Dry runs are left out, as in `agentsOverview`, so the spend page and the Agents table show the same figure.
- Dream usage counts toward cents, `weekToDate` and `wouldExceed` (DR.1 note) but not toward `tasks`. A day with only dream spend gets a row with `tasks: 0`.
- Week starts Monday 00:00 workspace time. Weekly totals sum the rounded agent-day cents.
- `wouldExceed` is true when spent >= the agent cap or the workspace spent >= the workspace cap. A null cap never trips.

## Nits left

- `weekToDate` and `wouldExceed` take no principal and do not call `authorize()`. They are internal calls for SP.3 and are not on the router. The agent lookup is not scoped to a workspace.
- `workspace` and `byAgent` count runs in other people's private sessions, unlike `agentsOverview`. Cap accounting needs every run, but the spend page's task counts can show that activity.
- `spend-rollups.ts`: the `cents` accumulator holds USD until the final map.
- `spend-rollups.test.ts`: no rollup test places a run near a DST change, and every service test uses Australia/Sydney. `paddedWindow` has no test of its own.
- `usage-cost.ts`: `reportedCostOf` has no direct unit test for a string or infinite `costUsd`.

## Ideas beyond scope

- Decide whether the spend page's task counts should hide private sessions (SP.3 or SP.4).
- Add a principal-checked wrapper over `weekToDate` if a user-facing read of it is ever needed.

## Steps for Dom

None.
