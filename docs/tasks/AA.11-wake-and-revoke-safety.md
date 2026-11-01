---
id: AA.11
title: "Gate 1: wakes carry no delegation and ask for tools, managed refused, revoke reaches the whole chain"
milestone: AA
size: M
status: in_progress
depends_on: [AA.8]
branch: task/AA.11-wake-and-revoke-safety
lane: services
executor: claude
---

Spec: `docs/v3/agent-connections.md`. Findings with failing scenarios, code locations and checks: `docs/reviews/AA-1.md`, sections M1, M2 and M3 and finding N9. A scratch reproduction is at `/home/roboto/devel/harbourmaster-wt/tmp/AA-gate/repro/gate.test.ts`.

## Scope
- M1, including the decision below: a wake has `onBehalfOfUserId` null and an actor of `{ kind: "peer", id: connection.id }`. A peer's request can't reach the new path through `deriveSubject`.
- Decision by the controller for Dom, 2 November 2026: `tool_policy` gates a wake. The spec's reason for the default is that a remote message is prompt input to an agent that may hold shell access, and a wake is the one case where that input arrives with nobody watching. `peerAsksEveryTool` walks the whole chain and asks if any peer link asks or has ended, so a wake on an `agent_rules` connection under a run started on an `ask` connection still asks. A daemon without `currentApprovals` can't claim a wake. `answerAsPeer` stays unable to answer a wake's question. Update the wake paragraph and the `tool_policy` row in the spec.
- M2: `refusePeerHandoffToManaged` refuses a wake through an explicit start option. `addOutbound` refuses a managed agent, in the words `publish` uses. `outbound.admit` refuses a run on a managed agent.
- M3: `onConnectionRevoked` and the sweep cancel every live run whose chain reaches the connection: hand-offs, wakes, and descendants of a parent that has ended. Batches stay bounded, and `runs.cancelRun` itself doesn't change.
- N9: `pairableAgent` hands out no codes for a managed agent.

## Check
Every check listed under M1 (both parts), M2 and M3 in `docs/reviews/AA-1.md`, and tests F1, F1b, F2 and F3 from the repro pass when moved into the repo's tests. Add a test for N9. `bun run check && bun run test && bun run build` pass. The workerd `guest execution` and `ArtifactRoom` timeouts are known load flakes; if one is the only failure, run it alone and record that.

## Log
- 2026-11-02: created from gate 1. Dispatched.
