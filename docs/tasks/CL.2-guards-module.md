---
id: CL.2
title: One guards module for services
milestone: CL
size: M
status: todo
depends_on: []
branch: null
lane: services
executor: claude
---

From the 10 Nov 2026 review. `requireUser` is defined in 13 service files with three meanings, `readableWorkspace` in three, and `via === "session"` is checked inline in 17 files.

## Scope

- One module beside `authz.ts` exports `requireUser`, `requireSession`, `readableWorkspace` and the owner fallback. Each meaning gets its own name.
- Services import it. No behaviour change.
- The same pass moves `idString`, `hostOf`, `invalid`/`notFound` and `TRAILING_SLASHES` to one home each.

## Check

- Tests pass before and after with no test edits beyond imports.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-10: added from the 10 Nov review, after Dom's decisions (members are trusted with credentials, the assistant may approve skills, assistant conversations share the thread list and are marked).
