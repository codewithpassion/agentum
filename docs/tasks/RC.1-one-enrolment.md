---
id: RC.1
title: One enrolment for both machine roles
milestone: RC
size: M
status: done
depends_on: []
branch: RC-rust-client
lane: services
executor: codex
---

Spec: `docs/v3/machine-client.md` ("Server changes (RC.1)"); detail in `docs/v3/machine-client/server.md` section 2.

## Check
- Tests:
  - An old daemon body and an old computer body enrol exactly as before, and get exactly today's answer (no new keys).
  - A new body with both roles makes one machine whose one credential opens the relay socket, the computer socket and the run routes.
  - A new body with one role works for each role.
  - The answer to a new body carries `machineName` and `roles`.
  - A code minted for one role can't enrol the other.
  - The enrol dialog offers the roles choice; the new choice's command uses `/install-agentum.sh` (the route itself can answer 404 until RC.6).
  - `hello_ack` is unchanged.
- `bun run check && bun run test && bun run build`, then the bundle grep for `drizzle` in `apps/web/dist/client`.

## Log
- 2026-11-05: Codex built it (04d3adbb). Opus review approved; added cross-role 401 tests, /mcp tests, the old 400 text, singleUser false for computer-only (fix commit on RC.1-wip). Merged into RC-rust-client.
