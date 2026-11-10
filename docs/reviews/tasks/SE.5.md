# SE.5 review

Round 1 at 6a8df1a: clean, no must-fix.

## Nits left

- `answer` still stores the raw question text as its JSON keys on answered rows, because the runtime matches answers by text. Dom chose this. SE.5 clears `question_keys` only.
- Rows settled before SE.5 keep their `question_keys`. Clearing them takes a data-only migration (`UPDATE run_requests SET question_keys = NULL WHERE status <> 'pending'`). The task did not ask for it.

## Ideas beyond the scope

- That backfill migration, if Dom wants old rows cleared.

## Not verified

- Staging checks in the task file (the controller runs them).
- `web#test` "guest execution" failed twice in my first runs (fetch failed in a node subprocess) and passed in the final full run, so it looks flaky. It touches no code in this diff.

## Steps for Dom

- Decide on the backfill migration above.
