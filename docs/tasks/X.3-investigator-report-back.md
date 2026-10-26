---
id: X.3
title: Investigator agent that control-plane starts and that reports back
milestone: X
size: S
status: todo
depends_on: []
branch: null
lane: services
executor: claude
---

control-plane watches for expected events that don't arrive. On a miss it opens an incident and starts a Harbourmaster agent through an existing HTTP trigger (contract C1: `POST /api/triggers/:id`, `Bearer hm_trg_`, body `{text, requestId}`). The agent investigates and must tell control-plane how it went, so control-plane can close the incident or escalate to a person (contract C3 in `~/devel/ai-os-integration/CONTRACTS.md`). The trigger side already works; this task is the report-back.

## Scope
- An "investigator" agent profile in the HEI workspace with a skill that, at the end of every run, posts one event to control-plane `POST /ingest/events` with a `cpt_` token scoped `ingest:events` (stored as a workspace secret, never in the prompt):
  `{ type: "investigation.result", source: "harbourmaster", payload: { incidentId, runId, outcome: "fixed" | "escalate", summary, steps[] } }`.
- The incident id arrives in the trigger `text` and as `requestId`. A run that fails or is cancelled still reports `escalate`.
- If posting the result fails, the run's result text says so; control-plane escalates on its own after a timeout.

## Check
- A test run started through the trigger on staging with a fake incident id posts one `investigation.result` to control-plane staging.
- `bun run check && bun run test` pass if code changed.

## Log
- 2026-10-26: requested by the integration coordinator (contract C3).
- 2026-10-26: Dom: next free services slot (after V1.5).
