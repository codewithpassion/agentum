# JB.9 Save keeps what the draft review shows

Path (a), as the controller decided on 20 Nov 2026. Commit 06fa01d0.

## What changed

`draftRoutineInput` builds the saved prompt with a new `draftPrompt`: the `does` text (or `when` if `does` is blank), then "Ask first: ..." and "Send the result to ..." lines when the draft has `asksBefore` or `deliversTo`. The "Edit first" dialog starts from the same prompt. `draftChips` shows the asks and delivers chips only for a routine draft with a cron, the one kind whose save keeps them. A web trigger carries no prompt (`triggers.create` takes only an agent and a name), so its card no longer shows those two chips.

## Verdicts

Round 1 (06fa01d0): clean, no must-fix. `bun run check`, `bun run test` and `bun run build` pass.

## Nits left

- `packages/services/src/jobs.ts:219`: the saved row shows only the first prompt line, takes `asksBefore` from the agent's ask level and sets `deliversTo` to null, so the row does not repeat the two lines the person approved. Outside JB.9's scope.
- `job-logic.ts` `draftPrompt`: with `does` and `when` both blank and an extra set, the prompt is only that extra line and the job is named "New job". Edge case, no harm.
- `draft-review.tsx`: for a web-trigger draft the "does" chip shows the full text, while the save keeps it only as the trigger name (first line, 80 characters). Existed before.
- No test covers a routine draft with a null cron hiding its asks and delivers chips.

## Ideas beyond the scope

- Give the web trigger a prompt field so a drafted web job keeps what the person wrote.
- Have the job row read the extra prompt lines back as the asks and delivers chips.

## Steps for Dom

None.
