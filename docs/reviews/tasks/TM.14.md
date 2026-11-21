# TM.14 review

Fake runtime for a team lead. A lead's room run now calls `team_post` for `assign:handle` and `team_propose_change` for `team_propose_change:<field>=<value>` through `/mcp` with its own run token (`packages/services/src/runs/fake-lead.ts`).

## Verdicts

- Round 1: must-fix. The `assign:@handle` marker was itself a mention, and the reply "Assigned this to @scout" woke the assignee again. Fixed by accepting `assign:handle` (the `@` form still works but wakes the member directly) and replying without `@`. Also case-insensitive handle matching.
- Round 2: clean.

## Decisions

- `scripts/dev/team-propose.ts` is kept. The task said it "can go", but its `--tool`/`--args` path still drives `team_discussion`, `ask_decisions` and `team_open_topic` in `docs/reviews/TX-e2e.md` and TM.10's notes.

## Nits left

- `team_propose_change:<field>=<value>` takes the value to the end of the line, so trailing words become part of the value.
- `WAKE_TAIL` in `fake-lead.ts` copies the wording in `inbox/wake-input.ts`; a shared constant would stop drift.
- A JSON or SSE parse failure reads as "could not be reached".
- No test covers the `@` form of the marker.

## Ideas beyond scope

- Markers for `team_discussion`, `ask_decisions` and `team_open_topic`, then `team-propose.ts` can go.

## Skipped

- The browser step ("the walkthrough with no script"), left for the single pass after all tasks merge.

## Steps for Dom

None.
