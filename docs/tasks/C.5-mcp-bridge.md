---
id: C.5
title: MCP bridge hardening
milestone: C
size: M
status: done
depends_on: [C.4]
branch: task/C.5-mcp-bridge
---

From the C.0 spike (`docs/reviews/spike-pi-durable.md`, "Proposed tasks" and the findings above it). Dom said go on all Cloudflare agent tasks on 17 Oct 2026. Read the spike report first. The prototype is in `/home/roboto/devel/harbourmaster-wt/tmp/spike-pi-durable/`, read-only, and code can be lifted from it.

## Scope

Reconnect when a tool list changes, since a Pi session fixes its tools when it's created. Decide between in-process tool ports and a self service binding for the Durable Object to reach `/mcp` and `/api/proxy`, and write the decision in the review file.

## Check

Tool calls through `/mcp` and `/api/proxy` work locally. The controller confirms them on staging after deploy. `bun run check && bun run test && bun run build` pass, and the bundle grep for `drizzle` passes.

## Log
- 2026-10-17: added from the C.0 spike (Dom: go on all).
- 2026-10-17: dispatched on task/C.5-mcp-bridge.
- 2026-10-17: review clean after 1 fix round at 5ff92f8 (docs/reviews/tasks/C.5.md). Merged. Decision: DO fetches its own public origin (custom domain), loopback via ctx.exports as fallback. Staging self-fetch check still open: needs a workspace model key on staging.
- 2026-10-17: staging check passed (docs/reviews/staging-cloud-check.md): DO self-fetch of /mcp and /api/proxy works on the custom domain; loopback not needed.
