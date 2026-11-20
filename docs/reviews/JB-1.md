# JB gate, round 1

Commit 584ea3a4 on main, reviewed as `git diff jb-start..584ea3a4`, JB work only (JB.1 to JB.7 and the JB.5 fix). Read against the JB section of `docs/v4/build-plan.md`, the task files `docs/tasks/JB.*.md`, `docs/reviews/JB-e2e.md`, `CLAUDE.md` and "Rules that are easy to break" in `docs/HANDOVER.md`.

Verdict: **not clean**. Two must-fix and ten nits.

The read model, the cron words, Run now through the cron's `startRun` path with `last_fired_at` written alongside, the card's "Done 9:04 am: ..." line and the admin-only `setTimezone` all match their task files. The first must-fix is about `/jobs` replacing `/routines` and `/triggers`: an agent's proposal now reads as a paused job, and Resume approves it. The second is about the draft review showing more than the save keeps.

Checks run in the review worktree: the JB service tests (jobs, roster, job-drafting, cron-to-words, workspaces: 109 pass) and the JB web tests (jobs components, Jobs tab, settings, find-registry, router, workspaces-router: 115 pass). `bun run check` and `bun run build` both pass, and no `drizzle` shows up in `apps/web/dist/client`. I ran no browser walkthrough, because JB.4, JB.5 and JB.6 each have one on record.

## Findings

| # | Severity | Finding | Area | Resolution |
|---|---|---|---|---|
| 1 | must-fix | A routine or web trigger that an agent proposed looks like a paused job on `/jobs` and on the Jobs tab. `JobSentence` has only `enabled`, and `jobs.ts` sets it to false for a pending proposal, so the row shows a "Paused" chip and a "Resume" button. Resume calls `routines.setEnabled` or `triggers.setEnabled`, which approve a pending proposal (`routines.ts` setEnabled, and the comment in `jobs-panel.tsx`). A person approves an agent's proposal without being told it is one. Run now is offered on the same row and fails with "Routine is revoked or awaiting approval". The Needs you card's "See changes" still links to `/routines` and `/triggers` (`desk/proposal-actions.tsx`). Both now redirect to `/jobs`. There the row shows only the first line of the proposal and no Approve or Reject. Approve and Reject survive only inside the Edit dialog's Routines or Triggers panel. The old `/routines` page showed the proposal with Approve and Reject on the list itself. `jobs.test.ts` locks in `enabled: false` for a proposal. | JB.2 read model, JB.4 row and redirects | Task below (JB.8) |
| 2 | must-fix | The draft review shows things that Save drops. The drafter returns `asksBefore` and `deliversTo` when the person names them, and `DraftReview` shows them as "Asks first: ..." and "Sends to ..." chips. `draftRoutineInput` saves only cron, name, prompt (= `does`) and timezone. The saved job never shows them again, because the read model always sets `deliversTo` to null and takes `asksBefore` from the agent's ask level, and the agent never receives them. Take "Every Friday summarise tickets and post them to #support": the review says "Sends to #support", but the saved routine's prompt has no destination. | JB.3 drafter, JB.4 save | Task below (JB.9) |
| 3 | nit | `/jobs` and the Jobs tab have no form for creating a job. The only create path is the drafter, which needs an Anthropic key ("This workspace has no Anthropic API key"). Edit opens the Routines or Triggers panel, which holds the create forms, but Edit exists only on a job that already exists. The old `/routines` had "Create routine". A workspace without a key (for example one with only My computer agents) can still create jobs from the Map's new-trigger flow, so nothing is lost outright. The redirect target just has no path for it. | JB.4 | Add a "Create by form" link next to Draft job that opens `CreateRoutineDialog` or `CreateTriggerDialog` for the agent, or point to it from the no-key error |
| 4 | nit | The drafter shows the model's own `when` text, not words computed from the cron it returned. If the two disagree (the model writes "Every Friday" but the cron is `0 9 * * 4`), the person approves the words, and the saved sentence then reads "Every Thursday at 9:00". The raw cron is shown in small mono text under the chips. | JB.3 | In `reconcile`, set `when` for a routine to `cronToWords(cron, timezone, workspaceTimezone)` |
| 5 | nit | The timezone help text says "Routines read their schedules in this zone unless a routine sets its own". In fact every routine stores its own zone at creation: `routines.create` falls back to the workspace zone and writes it, and the drafter always returns a zone. Changing the setting only affects new routines. Existing ones then show "(Sydney time)" labels. | JB.4 `timezone-form.tsx` | Reword to "New routines use this zone" |
| 6 | nit | Users still read "routine" and "trigger" on the Jobs surfaces, against the Vocabulary table (Job covers routines and web triggers): the Edit dialog ("The routines of X", "The web triggers of X"), the panels inside it ("Create routine", "Last fired"), the timezone help, the Find hint "Schedules and triggers", and the save error "A routine needs a cron schedule". | JB.4 | Word pass on the Jobs-owned strings. The reused panels can wait for the edit-in-place form noted in JB.4's log |
| 7 | nit | When the last run is still live, the last-result line reads "Last run running, 2 minutes ago". | JB.4 `job-logic.ts` | "Running since ..." or "Started 2 minutes ago" |
| 8 | nit | `jobs.read` runs one `runs` query per trigger inside `Promise.all`, so N jobs cost N+1 D1 round trips on every list. | JB.2 `jobs.ts` | One windowed query (`row_number() over (partition by actor_id ...)`), as `roster.ts` does |
| 9 | nit | The describe box keeps its text after Save job. This was noted in JB.4 and JB.5 and is still open. | JB.4 | Reset `DescribeJob` after a save, for example with a key bumped by `JobsPanel` |
| 10 | nit | Contract-lane drift: JB.2 and JB.3 edited `apps/web/src/server/compose.ts`, and JB.3's first merge conflicted there. JB.4 added a new `workspaces.timezone` procedure outside the contract. Rule 1 of "Rules for parallel work" gives those files and the final procedure list to JB.1. No functional harm. | Process | Record in the build notes. No code change |
| 11 | nit | The drafter has never run against a live model, only a fake model and a browser stub (JB.4 log, JB-e2e "Steps for Dom"). The request shape (`tool_choice: auto`, the root `type: "object"` patch) is untested against the real API. | JB.3 | Dom's live check from JB-e2e stays open |
| 12 | nit | Slack jobs always read "Not run yet". `jobs.ts` hard-codes `lastRunAt` and `lastRunOk` to null for `slack`, because Slack runs carry the linked user as actor and no link to the app. JB.2 asks for last runs from `runs` for every source. The code comment says why, but the user sees a Slack agent that has answered many messages labelled "Not run yet". | JB.2 | Hide the last-result line for Slack, or show "Runs when mentioned", until runs can be tied to the app |

## Task-ready scope and check for each must-fix

### JB.8 A proposed job reads as waiting for approval, not paused

From the JB gate (finding 1).

Scope

- Add `awaitingApproval: boolean` to `JobSentence` in `@repo/db/shared` (contract-owned file, so the controller assigns this to the contract lane or allows it here), and set it in `jobs.ts` from `isPendingProposal(trigger)`.
- `job-row.tsx`: a job awaiting approval shows a "Waiting for approval" chip, not "Paused". It offers no Pause, Resume or Run now. It offers Approve and Reject, which call `routines.approve` / `routines.reject` or `triggers.approve` / `triggers.reject`. The web trigger's secret dialog still shows once on approve.
- Show the full routine prompt, or a way to open it, on a row awaiting approval, so the person sees what they approve.
- `desk/proposal-actions.tsx`: "See changes" goes to `/jobs` (or the agent's Jobs tab), not the redirecting `/routines` and `/triggers`.

Check

- `jobs.test.ts`: a pending proposal reads `awaitingApproval: true, enabled: false`, and an approved paused routine reads `awaitingApproval: false, enabled: false`.
- `job-row.test.tsx`: a row awaiting approval renders Approve and Reject and no Resume or Run now. A paused row renders Resume.
- Browser: seed a run-proposed routine, open `/jobs`, see "Waiting for approval", approve it, and see the row turn into an enabled job with a next run.
- `bun run check && bun run test && bun run build` pass.

### JB.9 Save keeps what the draft review shows

From the JB gate (finding 2).

Scope

- Choose one path and do only that:
  - (a) When a draft has `asksBefore` or `deliversTo`, `draftRoutineInput` adds them to the saved prompt as plain lines after `does`, for example "Ask first: ..." and "Send the result to ...". The same goes for the web trigger, if it carries a prompt.
  - (b) The drafter stops returning `asksBefore` and `deliversTo`: drop them from the tool schema and the system prompt and return null. `DraftReview` then never shows a chip that the save cannot keep.
- Whichever path, the review card shows exactly what is saved.

Check

- `job-logic.test.ts` for (a): a draft with `deliversTo: "#support"` produces a routine input whose prompt contains "#support". For (b): `draft.test.ts` shows the reply's `asksBefore` and `deliversTo` ignored and returned as null.
- `draft-review.test.tsx`: no chip appears for a field that the save drops.
- `bun run check && bun run test && bun run build` pass.

## Verdict

Not clean: 2 must-fix (findings 1 and 2), 10 nits.
