---
id: MA.2
title: See archived agents and restore them in the app
milestone: MA
size: S
status: done
depends_on: [MA.1]
branch: MA.2-archived-agents-ui
lane: web
executor: codex
---

Spec: `docs/v3/mcp-agent-management.md`, section MA.2.

## Check
- Tests:
  - The archived toggle shows only when there are archived agents.
  - Restore calls `agents.restore` and moves the row back.
  - A refused restore shows the message.
  - An archived agent's page shows the banner and Restore.
  - The tRPC procedure refuses someone who can't archive.
- `bun run check && bun run test && bun run build`, then the bundle grep for `drizzle` in `apps/web/dist/client`.
- Screenshots in a dev build (dev login) at 1440x900 and 390x844 into the log folder.

## Log
- 2026-11-05: Codex built the archived toggle, Restore buttons, the profile banner and agents.restore (f012ecb5). There is no archive date because none is stored. Controller review: screenshots match the spec. Merged with MA.1.
