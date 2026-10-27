---
id: N.1
title: Review nits in the desk and admin API (X.9, X.10)
milestone: N
size: S
status: done
depends_on: []
branch: task/N.1-desk-admin-nits
lane: admin-api
executor: claude
---

Dom asked on 27 Oct 2026 to clear the nits the X.9 and X.10 reviews left (`docs/reviews/tasks/X.9.md`, `docs/reviews/tasks/X.10.md`), plus one found in the X.10 staging check. Response shapes stay exactly as in `~/devel/ai-os-integration/CONTRACTS.md` (C4); never edit that file.

## Scope

- X.9: shorten `error` in `GET /api/desk/runs/:runId` to a short scrubbed message (C4 asks for one); drop the double visibility check in `readRun`; a run id longer than 200 characters answers 404, not 400; tests for the `offered`, `waiting` and `cancelled` status mappings.
- X.10: `requireAssigner` must not let a write key unassign connectors; `update_agent` on an archived agent fails before it saves anything or writes an event; `update_agent` guards `runtimeConfig` against a concurrent change; the key dialog text no longer says "Write keys can also send messages" if that is wrong for the scopes now; tests for an existing connector credential mode surviving a repeat update, `build-context.ts` passing `orgRole`, and `assign_skill` through the route writing its audit event.
- Secrets: an invalid secret name (for example with a hyphen) returns the real validation message to the UI and to `create_secret`, not "The request failed".

## Check

- Tests for each item. `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: added at Dom's request (clear review nits).
- 2026-10-27: dispatched.
- 2026-10-27: review clean after 0 fix rounds; merged.
- 2026-10-27: on staging (1e668ac2): an invalid secret name now returns the real validation message.
