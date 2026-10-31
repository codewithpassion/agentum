---
id: AA.6
title: "Agents reach peers through list_agents, send_message and get_run"
milestone: AA
size: S
status: in_progress
depends_on: [AA.5]
branch: task/AA.6-mcp-peer-tools
lane: mcp
executor: claude
---

Spec: `docs/v3/agent-connections.md`, the section "Our agent calling a peer". It wins over anything else.

## Scope
- `list_agents` also returns active connections with `outbound_policy` not `off` for the calling agent only, as `<connection-slug>/<agent>`, with `peer: true`, the peer's host and the agent's description. Update the tool descriptions so an agent knows that peers are outside the workspace and that a person may need to approve the message.
- `send_message` and `get_run` accept those slugs and route to AA.5's outbound service in `apps/web/src/server/mcp/ports.ts`, answering in the existing shape. `waitMs` works the same. Local agents behave exactly as before.
- Only a run principal may reach peers. An API key or OAuth client gets the local list only, because a connection belongs to one agent.
- A dry run records the send as skipped and sends nothing.
- No tool creates, approves, widens or revokes a connection. Add a test that fails if a tool's name contains `connection`, `invite` or `pair`, so nobody adds one by accident.

## Check
- Tests in `packages/mcp` and `apps/web/src/server/mcp` cover, each as its own test:
  - The listing for the owning agent, for another agent in the workspace, and for an API key.
  - Sending to a peer at each policy.
  - A revoked connection refused with a clear tool error.
  - A dry run sending nothing.
  - Local `send_message` and `get_run` unchanged, with the existing tests untouched.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-31: created.
- 2026-11-01: dispatched.
