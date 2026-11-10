---
id: CL.5
title: Shared helpers in apps/web
milestone: CL
size: M
status: done
depends_on: []
branch: task/CL.5-web-shared-helpers
lane: web
executor: claude
---

From the 10 Nov 2026 review. Small cross-cutting things have no shared home in `apps/web`.

## Scope

- `server/routes/respond.ts` for refusals, JSON errors and bearer 401s, and one `sessionUser(c, deps)`.
- `loadOrLogin(fn)` for the route loaders that repeat the 401 redirect.
- One `errorMessage` in `src/lib`, replacing the copies. The assistant UI reads an error code and stops matching server wording.
- Polling goes through `usePolledQuery`, which pauses in a hidden tab.
- `settings.artifacts.tsx` reads the workspace switch directly, not by fetching the first artifact.
- Remove the leftover redirect routes after checking for inbound links.
- Update `docs/v3/workspace-assistant.md` and WA.2, which still describe a page.

## Check

- Tests pass before and after. Counts of the removed copies in the review file.
- `bun run check && bun run test && bun run build` pass, and the bundle grep stays clean.

## Log
- 2026-11-10: added from the 10 Nov review, after Dom's decisions (members are trusted with credentials, the assistant may approve skills, assistant conversations share the thread list and are marked).
- 2026-11-11: Dom lifted the cleanup hold. Dispatched to a Sonnet implementer on task/CL.5-web-shared-helpers, with a per-task review as team-lead relayed, in parallel with the other CL tasks.
- 2026-11-11: Merged as 2b9a7f69, review clean with 0 fix rounds. Its merge of main had picked up apps/agentum/pid, so the controller untracked it and added it to apps/agentum/.gitignore on the branch. check, test and build passed on main, and the bundle grep was empty. The implementer left WA.2 to the controller, which logged the change there.
