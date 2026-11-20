---
id: RH.11
title: "Cloud runs on any dev port"
milestone: RH
size: S
status: todo
depends_on: [RH.7]
branch: null
lane: worker
executor: claude
---

From the RH walkthrough (`docs/reviews/RH-e2e.md`).

`apps/web/.env.local` sets `PUBLIC_BASE_URL=http://localhost:3917` for the Pi durability e2e. On any other port a Cloud run never starts: the MCP server URL fixed into the run points at 3917, the log repeats "PiRun: MCP server harbourmaster did not list its tools Network connection lost", and the run shows "Working" with an empty log until the two-minute start timeout. Worktrees must run on their own port (workflow.md), so every walkthrough that uses a Cloud agent hits this.

## Scope

In dev, fail the run fast with a message that names the port mismatch when `PUBLIC_BASE_URL` is a localhost address that does not match the request's origin.

## Check

A test with a mismatched localhost URL. Browser: a Cloud agent on a non-default port fails within seconds with the message.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the RH walkthrough.
