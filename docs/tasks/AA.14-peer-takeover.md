---
id: AA.14
title: "Gate 1: a peer-rooted run can't request a human takeover"
milestone: AA
size: S
status: done
depends_on: [AA.13]
branch: task/AA.14-peer-takeover
lane: services
executor: claude
---

Spec: `docs/v3/agent-connections.md`. AA.13 capped a peer-rooted question at 1 hour so a peer can't hold an agent for a day per message. Its reviewer found that `request_human_takeover` skips the tool gate and still holds an agent for 24 hours. See `docs/reviews/tasks/AA.13.md`.

## Scope
Decision by the controller for Dom, 1 November 2026: refuse it. A message from outside has no business asking a person to take over a computer, so a run whose chain reaches a peer can't open a takeover request. That includes hand-offs and wakes, using `peerRootsOf`. The tool returns a clear refusal and the run carries on. Member runs behave as before. Enforce this where the request is opened in the requests service, on every runtime, not only in the tool definition.

Add a line to the "What the agent sees" section of the spec.

## Check
Tests that a takeover request is refused for a run a peer started, a hand-off of it and a wake, on the path both the cloud and machine runtimes use, opening no request and leaving the agent free. A member run's takeover still opens. `bun run check && bun run test && bun run build` pass. The workerd `guest execution` and `ArtifactRoom` tests and the Chrome print test are known load flakes; if one is the only failure, run it alone and record that.

## Log
- 2026-11-01: created from AA.13's review. Dispatched.
- 2026-11-01: merged, review clean.
