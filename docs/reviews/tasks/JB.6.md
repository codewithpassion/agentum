# JB.6 review: the card says how the last run went

## Verdicts

- Round 0 (opus reviewer on 2e43360): clean, no must-fix. All four required roster tests present and passing, plus mail-subject, timezone and running-newer-than-done cases.
- Browser proof (fresh verifier, `docs/reviews/tasks/JB.6/browser.md`): pass at 1280x800 and 390x844. Card reads "Done 4:13 pm: <title>" after Run now, with ". Next run 23 Nov, 9:00 am" when a routine exists, and "Idle" before any run.

- Round 1 (fresh opus reviewer on c648a021, commits after 2e43360 only): clean, no must-fix. After the first clean verdict the dispatcher joined "Next run" to a title that already ends in `.`, `!`, `?` or the ellipsis character with a single space instead of ". " (a clipped title had shown "fla...."). A parameterised test covers `?`, `.`, `...` and the single ellipsis character. Roster tests (41), `bun run check`, `bun run test` and `bun run build` pass.

## Nits left

- Round 1 nits: the join test has no `!` case and repeats its title column; a closing quote or bracket after punctuation, a trailing `:` or `;`, and full-width `？` or `。` still get ". ". All rare and cosmetic.
- A `finishedAt` in the future (clock skew) counts as "within a day" and shows "Done" with a future time. Unlikely, since the server sets it.
- `recentlyFinishedAt` runs twice per agent (once for the subject lookup, once in `activityFor`). Negligible cost.
- The card's `line-clamp-2` does not clamp in the browser (pre-existing, also on the job line), so a long line wraps to three or four lines instead of being cut. Nothing is hidden.
- The browser pass saw two 400 console errors outside the task's flows: `/api/dev-login` ticket redemption in a session that was already signed in, and the Jobs tab "Draft job" action with no Anthropic key. Home loads at both sizes had no console errors.

## Beyond scope

- The 24-hour fall-back to "Idle" is covered by unit tests only; the browser cannot age a run.
- The "Done" line has no date, so a run finished yesterday evening reads like one from today. The controller chose a bare clock time.

## Test notes

- `apps/web` `guest-execution.test.ts` (known flake) failed in the full run under load and passed alone (1 pass, 127 s).
- The reviewer's `bun run test` hit one Rust test, `desktop::apps::tests::the_session_bus_listens_where_the_environment_says`, which fails only because the worktree path is too long for a D-Bus socket. No Rust changed.

## Steps for Dom

None.
