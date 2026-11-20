# JB.4 review: Jobs tab and the workspace Jobs page

## Verdict per round

- Round 1, 757e4ab5: must-fix. Pausing a mail job always failed, because `triggers.setEnabled` does not accept mail triggers. Pause and Run now errors were wiped by the reload that followed. On `/jobs`, rows of archived agents offered actions that did nothing. The new `workspaces.timezone` query had logic in the router.
- Fix round 1, 7cb15cb4: clean. Mail pauses through `setTrigger`, action errors stay visible, rows of archived or unlisted agents are read only, and `workspaces.timezoneOf(principal)` does the read.
- Browser proof on 7cb15cb4: pass at 1280x800 and 390x844, see `docs/reviews/tasks/JB.4/browser.md`. The draft was mocked because the local workspace has no Anthropic key.

## Decisions worth knowing

- The shared parts live in `components/jobs/`, not in the room tab folder, because the room tab and `/jobs` both use them. `components/agent/room/jobs/index.tsx` is a thin tab around `JobsPanel`.
- No routine or trigger update procedure exists, so Edit opens the agent's Routines or Triggers panel in a dialog. A mail or Slack job sends the person to the agent's Keys tab. A drafted routine can be reviewed in the existing create-routine dialog, which now takes an `initial` prop.
- A drafted routine saves through `routines.create`, a drafted web trigger through `triggers.create` with its one-time secret dialog. A mail draft cannot be saved here and points to Keys.
- The timezone setting is a new Settings page, `/settings/timezone` (nav group "Jobs"), with a `workspaces.timezone` read for every member and `setTimezone` for admins.
- `/routines` and `/triggers` are redirect routes to `/jobs`. Find has one "Jobs" entry. `MailStartChip` is deleted, because the Jobs tab shows the mail start as a sentence.

## Nits left

- A successful reload never clears an error left by a failed load.
- The describe box keeps its text after a draft is saved or discarded.
- The draft shows "Asks first" and "Sends to" chips that neither create call stores, and an http draft drops `does`. The review does not say so.
- A trigger proposal waiting for approval shows Paused and Resume. Resume approves it.
- `jobs-panel.tsx` repeats the empty-`does` fallback that `draftRoutineInput` has.
- No test shows that pausing a mail row calls `setTrigger`. Only the `pauseTarget` mapping is tested.
- `desk/proposal-actions.tsx` and `thread/task-thread.tsx` still link to `/triggers` and `/routines`. The redirects make them work.
- The timezone is free text, not a list of zones. The server validates it.
- The Edit dialog's routines table was wider than the dialog on desktop. The dialog is wider now (`sm:max-w-5xl`), not re-checked in the browser.

## Beyond the scope

- A `routines.update` and `triggers.update` would let Edit be a real form in place, with the existing create dialogs reused.
- `jobs.draft` could return `asksBefore` and `deliversTo` into a place that stores them, or the review could drop those chips.
- The slack job has no pause because no procedure pauses a Slack app start.

## Steps for Dom

- Add the workspace Anthropic key if there is none, then try "Every Friday, summarise support tickets for me" in an agent's Jobs tab or on `/jobs`. The drafter has only run against a fake model so far (see the JB.3 review).
- `bun run test` fails `guest-execution.test.ts` on this host in some full runs. It is a known flake on `main` too.
