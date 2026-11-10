# TH.2 review: a thread page with a stable URL

## Verdicts

- Round 0 (49b08676): not clean. Three must-fix items. The thread route was missing from `isTaskLayout`, so the page lost its full-height layout. The `/tasks/$runId` redirect dropped the URL fragment, which broke the rail's `#computer` link. The task log notes were missing (the implementer may not edit `docs/tasks/`, so they are below).
- Round 1 (ffc6b626): not clean. Skipping `router.invalidate()` after a reply from `?run=` showed stale cached data for the bare thread URL.
- Round 2 (46182a7a): clean.

## What changed

- `/threads/$sessionId` shows the thread with the composer. Search holds `run` (the run in view, none means the latest) and `tab` (none means the conversation). The loader reads the run from `?run=`, so switching tabs does not reload. A run of another thread under this URL is a 404.
- `/tasks/$runId` redirects to its thread, with `?run=` unless the run is the latest, and keeps `tab` and the fragment.
- A reply navigates to the bare thread URL and invalidates the router, so the page shows the new latest run on the same URL. The page remounts on a new latest run (keyed by run id), as it did before.
- The run picker and "Go to the latest run" link to the thread URL.
- `tasks.get` takes `{ runId }` or `{ sessionId }` (the session's latest run the member can see) and returns `session.title` (the stored name, else the first run's title), `pinnedAt` and `archivedAt`.
- The header shows the thread name with rename (Enter saves, Escape cancels), pin and archive, through the existing `sessions` procedures.
- find-registry: the route is dynamic, so it went into `EXCLUDED` in `find-registry.test.ts`, as the other id routes did. `rail/find-registry.ts` itself did not change.

## Log notes for the task file

- Replying while a run works: the composer is replaced by "Reply when it is done" (`bottomState` returns `working`), so a second message cannot start. Edit and resend cancels the active run, then starts a new one. Nothing was changed.
- How a long thread loads: `tasks.get` reads the session's events oldest first in pages of 500, three pages at most (1500 events), and sets `eventsTruncated`. No UI reads `eventsTruncated`. For a longer thread the newest events are the ones cut, and the page relies on the stream resuming from the last loaded event id to fill them in. Not verified on a thread that long. With three or more earlier runs, the page folds them behind "Show". Thread rows are not paged.
- Local browser check (dev login, a fake-runtime agent): started a task, replied twice, the URL stayed `/threads/<session>`, run 3 of 3 showed. `?tab=log` survived a reload. `/tasks/<first run>` landed on `?run=<first run>` with "Viewing run 1 of 3". Rename, pin and archive held after a reload.

## Nits left

- The tasks service test still casts for the both-ids case, and the other styles differ.
- No test for the foreign-run 404, the kept fragment, Escape not saving, or the reload after a reply from `?run=`. They need a router or DOM harness.
- `getTrpc()` is called inside the title handlers, not once.
- A reply from `?run=` loads the thread twice (navigation, then invalidate).
- Other links still point at `/tasks/$runId` and take the redirect hop.

## Ideas beyond the scope

- Show `eventsTruncated` in the thread, and read the newest events first.
- Sort pinned threads first in the thread list (TH.3).
- Show an "Archived" label in the header.

## Could not verify

- Staging check: open a thread, reply twice, reload (the controller's).
- `bun run test` has one failure that also fails on main: `apps/web/src/server/live-artifacts/guest-execution.test.ts` (environment). `packages/services` `runs.test.ts` once timed out under load and passes alone.
- The `#computer` fragment through the redirect, and a thread with more than 1500 events, were not run in a browser.

## Steps for Dom

None.
