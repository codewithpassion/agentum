# RH.2 review: Roster service

Implemented in Codex (two commits), fixed and finished by the dispatcher.

## Rounds

Round 1, at af1d8fe8: must-fix. Three findings, all fixed in 8dec4b6b.
- A routine's next run ignored the routine's own `timezone`. Now read in the routine's zone, else the workspace's.
- Bounced-mail problem cards were dropped from Needs you. They now count as `needs_you`, as in the rail. Failed and interrupted runs stay `stopped`.
- A running run's status line ignored the mail subject. It now uses `mailSubjectsOf` and `runTitleText`, as the desk does (one batched query).

Round 2, at 8dec4b6b: clean.

## Decisions

- Archived machine means `machines.status = "revoked"`.
- "This week" is a rolling seven days, the same window as the Agents overview and the rail.
- Stopped status lines: "Machine archived", "Failed", "Stopped part way".
- The next-run line includes a date: "Idle. Next run 1 Jan, 12:00 pm", shown in the workspace timezone.
- `isLead`, `learnedCount`, `teamId` and `weeklyCapCents` keep their stub values until the tasks that own them land.

## Nits left

- Only `running` counts as working. `queued`, `offered` and a `waiting` run whose request belongs to someone else read as idle.
- A failed run whose problem was dismissed in the rail still shows `stopped` until the next run.
- `assigneeOf(row, null)` skips the rail's fallback to the creator when the owner left the workspace.
- `members` is optional on the service only for the rail tests; `compose.ts` always passes it.
- `costOf` ignores a `costUsd` stored as a numeric string, which the rail's SQL would count. A total under half a cent rounds to 0 cents.
- The `row_number()` window ranks every visible run in the workspace on each call. The query count is fixed, but the scan grows with run history.
- The job line splits at abbreviations ("Dr. Smith" gives "Dr.") and keeps a markdown heading in the line.
- The 45-query cap in the 50-agent test is loose. The query counter in `rail.test.ts` is a module global.
- Some fixtures use the literal "Mail bounced" and a copied "Waiting" status on a problem card.

## Beyond scope

- Export a `problem` field on `RailCard` so the roster need not match on the status string.
- Index or bound the run-history window if the roster poll gets slow on large workspaces.

## Steps for Dom

None.

## Test environment

Under load (several worktrees building at once) three tests timed out in full runs: `an hour of never-claimed runs...` (services), `guest execution: HTTP cap/start...` (web) and a Rust test in `agentum-rs`. Each passed alone and none touches this change.
