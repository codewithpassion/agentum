---
id: MA.1
title: Create and manage agents over MCP from an OAuth connection
milestone: MA
size: M
status: in_progress
depends_on: []
branch: MA.1-mcp-agent-management
lane: services
executor: codex
---

Spec: `docs/v3/mcp-agent-management.md`.

## Check
- Tests:
  - An OAuth write connection sees and can use `create_agent`, `update_agent`, `get_agent`, `archive_agent`, `restore_agent`, `set_agent_owners`, `set_agent_ask_before`, `check_agent_address` and `reserve_agent_address`.
  - A read-only connection sees only `list_agents` and `get_agent`.
  - A run, a machine and a Slack sender see none of the write tools, and the services refuse them.
  - An OAuth write connection does not see or reach the secret, API key or enrolment tools.
  - The authorization matches the UI's: a member refused in the UI is refused here.
  - Restore refuses when the slug or address has since been taken.
  - The audit record names the OAuth client and user.
- `bun run check && bun run test && bun run build`, then the bundle grep for `drizzle` in `apps/web/dist/client`.

## Log
