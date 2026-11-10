# TH.5 review: a main thread with no runs opens

Implementation commit: 6dbadb21.

## Verdicts

Round 1 (Opus reviewer, 6dbadb21): clean, no must-fix.

## What changed

`tasks.get` by `sessionId` returns an `EmptyTaskView` (`run: null`, with the agent, session, title and relatives) for a session the member can see and that has no runs. A hidden session, or one in another workspace, still throws `not_found`. `get` has two overloads, so a call by `runId` still returns a `TaskView`. The web `TaskView` type is the variant with a run, and `loadTask` and `withRun` narrow it. `/threads/$sessionId` renders the new `EmptyThread` (header, empty history, composer) when the run is null. The first message calls `runs.start` with the session's external key (`main:<userId>`), then the route reloads into the normal thread page.

## Nits left

- The empty thread header is blank for a session with no name and no runs. A fallback such as the agent name would read better.
- `EmptyThread` always sends `runs.start` with `origin: "ui"`. A visible non-`ui` or sub-thread session with no runs would need `runs.reply` and the read-only note. That state does not occur today.
- The `navigate` after the send is redundant next to `router.invalidate()`. It also drops a `tab` search param.
- `emptyThreadOf` selects `agentModel` and does not use it, and runs `relativesOf` for `parent` and `children` that `EmptyThread` does not show.
- `emptyThreadOf` repeats the agent and session mapping from `viewOf`.
- The `withRun` error text describes the wrong condition.
- The service test narrows inside the assertion (`view.run !== null && ...`).

## Ideas beyond the scope

- Give a new main thread a real default title, so the rail and the header do not show a blank name.

## Not verified

- The staging check from the task file (the controller runs it after the merge).
- `apps/web/src/server/live-artifacts/guest-execution.test.ts` fails here with a Miniflare "fetch failed" and also fails the same way on the main checkout, so it is not from this change. A full `bun run test` reports that one failure. The reviewer saw 0 failures in `apps/web`, so it may depend on load from the other running agents.

## Local browser check

On a dev server (dev login), a seeded agent's "Open main thread" opened `/threads/<id>` with an empty history and a composer. Sending "hello main" showed the message and its run in the same thread, on the same URL.

## Steps for Dom

None.
