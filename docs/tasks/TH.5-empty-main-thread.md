---
id: TH.5
title: A main thread with no runs opens
milestone: TH
size: S
status: todo
depends_on: [TH.3]
branch: null
lane: web
executor: claude
---

Found on staging on 11 Nov 2026 during the smoke check after the CL merges. On a new agent's page, "Open main thread" goes to `/threads/<id>` and shows "Thread not found". `sessions.main` makes the session, but the thread route loads it through `tasks.get`, and `latestRunOf` in `packages/services/src/tasks/service.ts` throws `not_found` when the session has no runs. "New conversation" works because it starts a run first. This comes from TH.2 and TH.3, not from the CL refactors.

## Scope

- Opening a session the member can see, with no runs yet, shows the thread page with an empty history and a working composer. The first message starts the first run in that session.
- A session the member cannot see still shows "Thread not found".

## Check

- A service test: `tasks.get` by `sessionId` for a visible session with no runs returns it without a run, and for a hidden one it still throws `not_found`.
- A local browser check: a new agent, "Open main thread", send one message, and the run shows in that thread.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-11: added from the staging smoke check (verify3), not dispatched. Team-lead scoped the work to the CL tasks, so dispatch waits for a go.
