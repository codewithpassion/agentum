---
id: ME.19
title: "The outside-text guard catches late tool events and connector text"
milestone: ME
size: S
status: in_progress
depends_on: [ME.16]
branch: task/ME.19-late-web-events-and-connectors
lane: services-memory
executor: claude
---

From the ME.16 review (`docs/reviews/tasks/ME.16.md`, ideas beyond the scope).

## Decision

Controller decisions (Dom's "don't wait for me", 20 Nov 2026):
- The shell hold stays as ME.16 built it, covering machine, Managed Agents and Linux VM `bash`, skill scripts and the computer tools.
- Connector (MCP) tool results count as outside text, like the web. A note written after a connector call is held under "Tell me after" and "Quietly", as for web use.
- Late tool events: when a web, shell or connector tool event arrives for a run after one of its notes was already applied, the note moves to held and the owner is told.
- Session scope stays as ME.16 left it.

## Scope

- Count connector (MCP) tool calls in `usedWeb` (or its successor) for every runtime.
- On ingest of a late tool event that would have held a note, move that run's applied agent notes to held, record the change, and raise the usual Needs you card.

## Check

- Service tests: a note after a connector call is held; a note applied before a late web event arrives becomes held when it lands; a run with no outside text still applies at once.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the ME.16 review.
- 2026-11-21: dispatched on task/ME.19-late-web-events-and-connectors (v4 controller session).
