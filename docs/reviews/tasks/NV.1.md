# NV.1 review: one word per thing in the web app

## Verdicts

- Round 1 (ebe31aee): not clean, 1 must-fix. The Find entry "Board" opened `/desk?view=board`, whose heading is "Desk".
- Round 2 (2bd6b1ee, fixes only): clean. Find now says "Desk" with "Board" as its hint, and the Desk route exports `PAGE_HEADING`.
- Browser proof (fresh verifier, 2bd6b1ee): pass at 1280x800 and 390x844, no console errors, no failed requests. It found one missed string, the Triggers empty state ("start an agent run over HTTP"), fixed in 22c8d230. See `docs/reviews/tasks/NV.1/browser.md`.

## What changed

Sessions and agent threads read as conversations, runs read as tasks, and the New menu reads "New conversation" and "New agent". Each route behind a Find entry exports `PAGE_HEADING` and renders it in its `<h1>`. `find-registry.test.ts` imports each route and checks the Find label against it. The old Find names stay as hints, so searching "Schedules" still finds Routines. Q&A and Map take their headings from `components/qa/qa-heading.ts` and `components/map/map-heading.ts`.

Accepted exceptions to "label equals heading", listed with reasons in the test: Assistant (redirects to the Desk), Apps (the Artifacts page filtered to apps) and Enrol a machine (named after the page button, the page heading is Machines).

## Test environment

`src/server/live-artifacts/guest-execution.test.ts` failed twice with a miniflare ECONNRESET while other agents were running on this machine, and also failed on a stash of unchanged code. After `git merge main` the full `bun run test` passed, including that test.

## Nits left

- `/sessions` has no Find hint for the old word "Sessions", so typing "session" no longer finds Conversations.
- Find has two entries named "Artifacts" (`/artifacts` and `/settings/artifacts`), told apart by group.
- `settings.machines.tsx` exports a `PAGE_HEADING` that no test reads, because that entry is an exception.
- The Recent tasks card's "All tasks" link goes to `/sessions`, which is headed "Conversations".
- The Routines table column "Next task" reads oddly next to "Last fired". JB renames routines anyway.
- "Trigger conversation ·" beside "Open the trigger" in the conversation bottom bar is awkward but correct.
- The Log page shows raw event names (`run.queued`, `run.finished`). They are identifiers, left alone.
- The test checks that the route exports the heading, not that the `<h1>` renders it. Every route in the diff does render it.

## Beyond scope

- `server/artifact-content/bridge.ts:371` still shows users "Sent to the artifact agent thread", and `server/mcp/live-ports.ts:110` throws "Thread not found". Both are server strings, so a follow-up task owns them.
- Inbox threads become "topics" in TM. Their words ("New thread", "No threads yet", "Open thread") stay until then.

## Steps for Dom

None.
