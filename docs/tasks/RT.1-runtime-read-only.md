---
id: RT.1
title: Show the runtime as a fact, not a disabled choice
milestone: RT
size: S
status: todo
depends_on: []
branch: null
lane: web
executor: claude
---

From the 10 Nov 2026 review. The agent page shows three choice-like runtime cards and a disabled select, which look usable. Files: `apps/web/src/components/agent/profile/runs-on-card.tsx`, `agent-form.tsx` (`lockRuntime`), `profile/sheets/advanced.tsx`.

## Scope

- The Runs on card shows only the current runtime, as one line with its detail.
- The edit sheet shows a read-only line where the disabled select was. Remove `lockRuntime` if nothing else uses it.

## Check

- Component tests updated. No disabled runtime control remains on an existing agent.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-10: added from the 10 Nov review, after Dom's decisions (members are trusted with credentials, the assistant may approve skills, assistant conversations share the thread list and are marked).
