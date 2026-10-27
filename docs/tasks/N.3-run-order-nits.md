---
id: N.3
title: Review nits in run start order (W.10)
milestone: N
size: S
status: in_progress
depends_on: []
branch: task/N.3-run-order-nits
lane: runs
executor: claude
---

Dom asked on 27 Oct 2026 to clear the nits the W.10 review left (`docs/reviews/tasks/W.10.md`).

## Scope

- Tests: "oldest run still downloading blocks the offer" and "third failed download offers the next run".
- A run with pending file downloads holds back only what it must. Decide whether it should block the agent's other sessions, and write the rule in the review file.
- A download that lands while a live run is ending is offered once the claim is free, not left for the sweep.
- `expireUnclaimedRuns` offers the next waiting run, so it doesn't rely on the same tick's stale offer.
- Leave alone: the cross-isolate millisecond tie-break and the reaper offering early. Note them in the review file as accepted.

## Check

- Tests for each item. `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: added at Dom's request (clear review nits).
- 2026-10-27: dispatched.
