# TX.1 review

## Verdict

Round 1, commit a729f360: must-fix. `dream_questions` had a NOT NULL `agent_id` and no `team_id`, so a team dream could not raise its conflict question for the team owner (TX.2 says a team may have no lead).
Round 2, commit 11374fb8: clean. No must-fix findings.

The fixes: `dream_questions.team_id` and a nullable `dream_questions.agent_id`, a CHECK on `memory_changes`, `dream_runs` and `dream_questions` that a row has an agent or a team (never both, never neither), `memory.decide` refuses a team change on reject as well as approve, the generic `requests.answer` refuses a decisions row, a decisions display refuses duplicate question ids, and migration 0060 was regenerated without the no-op `foreign_keys` pragmas.

## Decisions made in the contract

- Migration 0060 is hand-edited from drizzle's output in three ways. `dream_questions` is stashed (`__old_dream_questions`), dropped, and recreated after `dream_runs` is rebuilt, because dropping a parent that still has child rows fails on D1, which cannot switch foreign keys off. Drizzle copies the new `team_id` column from the old table, which has none, and SQLite reads the double-quoted name as a string, so the copies select NULL instead. The CHECKs are unqualified, so they survive the rename.
- A later migration that rebuilds one of these three tables must keep that edit: drizzle's snapshot stores the CHECK qualified with the table name, so its generated SQL will not be safe as it comes.
- `team-extras-migration.test.ts` applies migrations 0000 to 0059, seeds rows in all three tables, applies 0060 inside one transaction and checks the rows, the foreign keys and the team columns.
- The four procedures sit in the existing `memory`, `dream` and `requests` routers. No new service or router was needed, so `compose.ts` and `router.ts` are unchanged. `discussions` has no procedure in this task.
- `requests.answerDecisions` takes `{ requestId, decisions }` where `decisions` maps a question id to the option chosen (or the text typed, where the question has `freeText`). The stored answer is `{ decisions: {...} }`, which keeps it apart from a question answer (`{ answers }`). `requests.dismissDecisions` takes `{ requestId }`. Both return the request record. TX.4 decides what dismissing does to the row; `cancelled` is the status that fits, so no new status was added.
- `memory.listTeam` takes `{ teamId, kind? }` and returns `MemoryNote[]`. `dream.runTeamNow` takes `{ teamId }` and returns `DreamRun`.
- `memory_changes.agentId`, `dream_runs.agentId` and `dream_questions.agentId` are now nullable in `MemoryChange`, `DreamRun` and `DreamQuestion`, each with a `teamId`. The Needs you held-notes query skips team rows until TX.2 shows them.
- `decisions` is a Needs you kind and a request kind. `outcomeText("decisions", ...)` gives one `<question id>: <answer>` line per answer. TX.4 should look up the question text for it. The Slack card builder throws for a decisions display until TX.6 adds a card.

## For the downstream tasks

- TX.2 owns undo and decide for team rows. Today `memory.decide` and `memory.undo` refuse a row with no agent.
- TX.4: `requests.answer` refuses a decisions row. `createRequestBodySchema` (the daemon create body) and `openInputSchema` still list only approval and question displays, so the `ask_decisions` tool needs its own open path.
- TX.3 needs the time a round opened for the ten-minute rule. `discussions` has only `created_at` and `round`, as the task lists. Add the column in a contract task, or work it out from the posts.
- TX.6: a decisions request currently makes the Slack card builder throw, which `onEvent` logs as "Slack request card failed". Nothing creates one before TX.4.
- DR.6 and any open branch that builds a `MemoryChange` or `DreamQuestion` fixture needs `teamId: null`.

## Nits left

- `packages/services/src/memory/service-team.test.ts`: the decide test is named "decided or undone" but only calls `decide`.
- `packages/services/src/memory/service.ts`: `agentOf(row)` runs once as a bare guard in `decide`, and again on the approve branch.
- `memory.listTeam` takes `teamId` as `z.string().min(1)` while `dream.runTeamNow` uses `idString`.
- `roster.ts` groups team change rows under a null agent key that no agent matches. Harmless.

## Beyond the scope

- Dreams and team dreams are not yet counted in spend (see the DR.1 record).
