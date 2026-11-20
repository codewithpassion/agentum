---
id: ME.4
title: "Agent tools: remember and search_history"
milestone: ME
size: M
status: in_progress
depends_on: [ME.1]
branch: task/ME.4-memory-agent-tools
lane: mcp
executor: codex
---

From `docs/v4/build-plan.md`, milestone ME. Two tools for agents in `packages/mcp/src/tools/`.

## Scope

- `remember(kind, text)`: calls `memory.add` as the run's agent with the run as source. Returns whether the note was applied or held.
- `forget_note(id)`: proposes a forget. It follows the same learn level.
- `search_history(query, limit)`: searches the agent's own past conversations through `sessions.search`, limited to sessions the run's principal may read, and returns snippets with dates and session ids.
- A run can use these only for its own agent. A peer run (`from.kind: peer`) cannot call `remember`.

## Check

- Tool tests with a fake memory service: applied and held replies, the peer refusal, history limited to the caller's visibility.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/ME.4-memory-agent-tools (v4 controller session).
