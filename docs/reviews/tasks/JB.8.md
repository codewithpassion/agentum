# JB.8 review: a proposed job reads as waiting for approval, not paused

## Verdicts

- Round 1 (5d2bc0c): clean, no must-fix. No fix rounds.
- Browser proof (fresh verifier, `docs/reviews/tasks/JB.8/browser.md`): PASS at 1280x800 and 390x844, no console errors, no failed requests.

## Nits left

- `job-logic.ts` `approvalTarget` comment says "web, mail or app trigger", but only routines and web triggers can be proposed. Mail and app rows can never be awaiting approval.
- `jobs-panel.tsx` `pause`: the "Resuming a proposed web trigger approves it" branch is unreachable from the row now, because awaiting rows hide Resume. Harmless, and its comment is out of date.
- `jobs-panel.tsx` `loadRoutinePrompts` lists every routine in the workspace to read one prompt, on each reload while a routine is pending. Putting the prompt on `JobSentence` would have been a second contract field.
- `jobs.test.ts` asserts `awaitingApproval: true` for a pending routine only, not for a pending web trigger.
- Desk "See changes" goes to `/jobs`, not the proposing agent's Jobs tab.

## Ideas beyond the scope

- The job row never shows `nextRunAt`, only the last run. The task check says the approved row shows "a next run". The field is set (verified in D1), but no text shows it. A "Next run in 2 hours" line on enabled routine rows would close that.
- Row buttons are 28px tall on a phone.

## Steps for Dom

None.
