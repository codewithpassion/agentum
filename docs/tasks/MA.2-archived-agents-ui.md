---
id: MA.2
title: See archived agents and restore them in the app
milestone: MA
size: S
status: in_progress
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
