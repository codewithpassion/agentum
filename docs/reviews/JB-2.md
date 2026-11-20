# JB gate, round 2

Commit 9dcb4cd0 on main, reviewed as `git diff jb-start..9dcb4cd0`, JB work only (JB.1 to JB.9). Read against the JB section of `docs/v4/build-plan.md`, the task files `docs/tasks/JB.*.md`, round 1 (`docs/reviews/JB-1.md`), `CLAUDE.md` and "Rules that are easy to break" in `docs/HANDOVER.md`. I checked other merges in the range only for whether they break JB. Since round 1 they touched `roster.ts` (SP.2 moved `costOf` to a shared reader), `compose.ts` (KY.9 added proxy access for the fake runtime) and the app shell (the new top bar). None of that changes JB behaviour, and the Jobs entry in Find still passes its test.

Verdict: **clean**. No must-fix. Both round 1 must-fixes are resolved. Four new nits, and nine round 1 nits stay open.

## Round 1 must-fixes

JB.8 resolves finding 1. `JobSentence` now carries `awaitingApproval`, set in `jobs.ts` from `isPendingProposal`, and `enabled` stays false for a proposal. A row awaiting approval shows a "Waiting for approval" chip instead of "Paused", is not dimmed, and offers only Approve and Reject. Pause, Resume, Run now and Edit are gone from it. Approve and Reject call `routines.approve`/`reject` or `triggers.approve`/`reject` by source. Approving a web trigger shows the secret dialog once. A routine proposal has a "See the full prompt" disclosure, fed from `routines.list`, which includes pending rows. The Needs you card's "See changes" now goes to `/jobs` for both kinds. Only routines and web triggers can be proposals, so sending every non-routine source to `triggers.approve` is safe. I searched `packages/` and `apps/web/src` for writers of `proposed_by_agent_id`. Only `routines.create` and `triggers.create` set it, through `proposalColumns`. App triggers from artifact grants are inserted with `approvedAt` set and the proposer null, and mail starts never carry one. `jobs.test.ts` checks both the pending reading and the approved-but-paused reading. `job-row.test.tsx` covers the chip, the buttons, the prompt disclosure, read-only and the paused row. The browser proof (`docs/reviews/tasks/JB.8/browser.md`) covers approve, reject, the web trigger secret and See changes at both sizes.

JB.9 resolves finding 2 by path (a). `draftPrompt` adds "Ask first: ..." and "Send the result to ..." as lines after `does`. `draftRoutineInput` and the edit-before-save dialog both use it. Web trigger drafts store only a name, so `draftChips` now hides the asks and delivers chips for every draft that does not save as a routine. The review card no longer shows anything the save drops. Tests cover the routine prompt lines, blank values and the hidden chips for http, mail and app drafts.

## Checks run

In the review worktree at 9dcb4cd0, after `bun install --frozen-lockfile` and copying `apps/web/.env.example` to the gitignored `apps/web/.env`:

- JB service tests (jobs, roster, job-drafting, routines, triggers, desk): 235 pass.
- JB web tests (`components/jobs`, `components/desk`, `components/agent/room/jobs`): 90 pass.
- `bun run check`, `bun run test` and `bun run build` pass, and `apps/web/dist/client` contains no `drizzle`. Turbo restored part of the build and test output from cache, under the same input hashes.

I ran no browser walkthrough of my own. JB.8 has a browser proof on record, and JB.9's check does not require one.

## Findings

| # | Severity | Finding | Area | Resolution |
|---|---|---|---|---|
| 1 | nit | Nothing on the Jobs surfaces shows `nextRunAt`. The read model works it out for every enabled routine, but `JobRow` shows only when, does and the last result. So the JB.8 browser check ("see the row turn into an enabled job with a next run") could be confirmed only in D1, as the JB.8 log says. | JB.4 row, JB.8 check | Add "Next run <time>" to the last-result line for enabled routines, or drop `nextRunAt` from the row's contract |
| 2 | nit | The "Asks first" chip means two things. On the draft review it is the person's words ("Asks first: Dom"), which JB.9 now saves as a line in the prompt. On the saved row it is the agent's ask level ("Asks first: Everything it does", or nothing for `rarely`). Straight after a save, the row can contradict the card the person just approved. `deliversTo` on the row is always null, so "Sends to ..." disappears after the save. | JB.2 read model, JB.9 | Label the row's chip by ask level ("Ask level: ..."), or read the "Ask first:" and "Send the result to" lines back out of a routine prompt |
| 3 | nit | A proposed web trigger's row shows nothing about the proposal. `does` is the agent's job line and `when` is "When its web address is called". The trigger's own name, the only thing the agent proposed, appears nowhere on the row, and Edit is hidden while it waits. | JB.8 row | Show the trigger name on a row awaiting approval, as the routine row shows its prompt |
| 4 | nit | `task-thread.tsx` still sends a trigger-started task's routing link to `/triggers`. The redirect delivers it to `/jobs`, so it works, but it is the last in-app link to the old route. | JB.4 redirects | Point it at `/jobs` |
| 5 | nit | Open from round 1 (#3): `/jobs` and the Jobs tab still have no create-by-form path. Without an Anthropic key the drafter is the only entry point. | JB.4 | As round 1 |
| 6 | nit | Open from round 1 (#4): the drafter shows the model's `when` text, not words computed from the cron it returned. | JB.3 | As round 1 |
| 7 | nit | Open from round 1 (#5): the timezone help still says "unless a routine sets its own", but every routine stores its own zone. | JB.4 `timezone-form.tsx` | As round 1 |
| 8 | nit | Open from round 1 (#6): "routine" and "trigger" still show on Jobs surfaces (Edit dialog, panels, timezone help, Find hint, save error). | JB.4 | As round 1 |
| 9 | nit | Open from round 1 (#7): "Last run running, 2 minutes ago" while a run is live. | JB.4 `job-logic.ts` | As round 1 |
| 10 | nit | Open from round 1 (#8): `jobs.read` makes one `runs` query per trigger. | JB.2 `jobs.ts` | As round 1 |
| 11 | nit | Open from round 1 (#9): the describe box keeps its text after Save job. | JB.4 | As round 1 |
| 12 | nit | Open from round 1 (#11): the drafter has still never run against a live model. | JB.3 | Dom's live check from JB-e2e |
| 13 | nit | Open from round 1 (#12): Slack jobs always read "Not run yet". | JB.2 | As round 1 |

Round 1 #10 (contract-lane drift) was a process note with no code change and is not carried forward. JB.8 edited the contract file `packages/db/src/shared.ts` with a recorded controller decision, so that is not new drift.

One thing outside JB, not counted. The Needs you card approves a proposed web trigger through `triggers.approve` and throws away the `secret` it returns (`sendDecision` in `desk/proposal-actions.tsx`), so a person who approves there never sees the secret. `sendDecision` predates JB, and JB.8 changed only the See changes link in that file. Approving from a `/jobs` row does show the secret.

## Task-ready scope and check for each must-fix

None.

## Verdict

Clean: 0 must-fix, 13 nits (4 new, 9 open from round 1).
