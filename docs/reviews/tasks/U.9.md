# U.9 review

## Verdicts

Round 1 (4428574): not clean. One must-fix: `queueOf` counted a running run of the same agent in any session, but cloud and managed runs wait per session. Fixed in b3eda59 (scoped to the session, counts offered and running runs, agent lookup filtered by workspace, cross-session test).

Round 2 (b3eda59): clean.

## Nits left

- Cancel shows once per run per Log page. A run whose `run.queued` row is on page 2 and `run.started` row on page 1 shows Cancel on both pages.
- Each Log load with a user-cancelled row makes one uncached Clerk `getUserList` call (ids deduplicated, at most 100).
- The header comment in `apps/web/src/server/clerk-people.ts` says the split keeps `compose.ts` free of Clerk imports, but `compose.ts` imports the file. `slack-directory.ts` says the same.
- The archive dialog calls `router.invalidate()` before it navigates, so the agent page reloads once before it is left.
- Escape or a click outside closes the archive dialog while the archive call is in flight.
- "Archive agent" also shows on an already archived agent. The service returns early, so it is harmless.
- The archive dialog has no component test.
- The queued text says "the agent's current run" (the task's wording), but the check is per session.
- An older run in the same session that is still `queued` also blocks the latest run, and the label then reads plain "Queued".
- No test for the workspace filter on the agent lookup in `queueOf`.

## Beyond the scope

- The task said to use "the directory lookup the app already has for members". The only Clerk directory in the app (`SlackDirectory`) has no name lookup, so U.9 adds a small `people` port on the events service, implemented in `apps/web/src/server/clerk-people.ts`. Other pages that show raw user ids could use the same port.
- The Log summary for other user-actor events still shows no person. Only `run.cancelled` names one.

## Steps for Dom

None. Browser check done on a local dev server with dev login: queued cloud run shows "Queued, waiting for the agent's current run to finish", the Log shows one Cancel for the run, the actor reads "Cancelled by Dev User" (an unknown id falls back to "Cancelled by user <id>"), and archiving an agent returns to the list without it.
