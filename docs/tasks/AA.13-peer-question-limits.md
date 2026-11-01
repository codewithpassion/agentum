---
id: AA.13
title: "Gate 1: peer questions expire in an hour, answers count against the limit, unsupported media refused"
milestone: AA
size: S
status: done
depends_on: [AA.11]
branch: task/AA.13-peer-question-limits
lane: services
executor: claude
---

Spec: `docs/v3/agent-connections.md`. Findings: `docs/reviews/AA-1.md`, sections "N1: one run at a time, judged" and "N13", and finding N5.

## Scope
- N1, decision by the controller for Dom, 1 November 2026: an `auto` peer must not be able to hold an agent for a day per message. A question from a peer-rooted run gets a 1 hour `ttlMs`. When it expires, the task ends in `TASK_STATE_FAILED` with a status message saying nobody answered in time, and the run is cancelled, so it can't simply ask again. Member runs keep the 24 hours.
- N13 as scoped there: answers count in `hourlyCountSql` and `hourlyUse`, and `continueTask` enforces the limit inside `claimAnswer`'s insert, answering 429 with `Retry-After`. Update the `hourly_limit` row in the spec.
- N5: a text or data part with a `mediaType` other than text or JSON types gets `ContentTypeNotSupportedError`. Keep accepting `text/plain` on text parts, because Hermes sends it.
- Add a line to the spec's "Not in this build" saying that one run at a time still means peer work queues with everything else, so an `auto` peer belongs on an agent that does nothing else.

## Check
Every check listed under N13. Tests that a peer-rooted question expires at 1 hour, fails the task, cancels the run and frees the agent; that a member run's question keeps 24 hours; and that `image/png` on a text part is refused while a Hermes text part is accepted. `bun run check && bun run test && bun run build` pass, and `scripts/e2e/a2a-hermes.ts` still exits 0. The workerd `guest execution` and `ArtifactRoom` timeouts are known load flakes; if one is the only failure, run it alone and record that.

## Log
- 2026-11-01: created from gate 1.
- 2026-11-01: dispatched.
- 2026-11-01: merged. The reviewer raised one must-fix, `request_human_takeover`, which the dispatcher left as out of scope. Controller moved it to AA.14. Hermes e2e 8 of 8.
