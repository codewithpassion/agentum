---
id: AA.12
title: "Gate 1: card refresh gets a caller, and peer-run tool cards lose Always allow"
milestone: AA
size: S
status: done
depends_on: [AA.8]
branch: task/AA.12-card-refresh
lane: web
executor: claude
---

Spec: `docs/v3/agent-connections.md`. Findings: `docs/reviews/AA-1.md`, section M4 and finding N11.

## Scope
- M4 as scoped there: the `refreshCard` procedure, a Refresh button on the detail page of an `a2a_outbound` connection, and a bounded daily tick job, oldest first, where one peer's failure doesn't stop the batch. First fix the round 5 nit in `docs/reviews/tasks/AA.2.md`: match `peerCard` in the WHERE of the `refreshCard` write.
- N11: hide "Always allow" on a tool approval card for a peer-rooted run, because it writes an agent rule for member runs and doesn't stop the asks in that run.

Don't touch `packages/services/src/a2a/outbound.ts`, `tasks.ts`, `requests.ts` or `runs.ts` beyond what N11 needs to know a run is peer-rooted: AA.11 is changing them.

## Check
Every check listed under M4 in `docs/reviews/AA-1.md`, plus a test that N11's card omits the option on a peer-rooted run and keeps it on a member run. `bun run check && bun run test && bun run build` pass. The workerd `guest execution` and `ArtifactRoom` timeouts are known load flakes; if one is the only failure, run it alone and record that.

## Log
- 2026-11-01: created from gate 1. Dispatched.
- 2026-11-01: merged, review clean after 1 fix round. Migration 0038 adds `peer_card_tried_at`.
