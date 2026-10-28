# LR.14 review

Task: live rooms authorize once per participant window, not per frame. Security-focused review by a Sonnet reviewer at high effort.

## Verdicts

Round 1 (57a3a7d8): not clean. Four must-fix items. `askPresence` invalidated every grant and so defeated the cache and failed unrelated admissions. `revalidate` applied a stale blob policy after an access change. A frame retry could reorder frames from one socket and so close it on a missing Yjs dependency. The fence test did not show what its name claimed and nothing covered a lookup that straddles an invalidation.

Round 2 (32e29185, fix commit only): clean. All four fixes confirmed. One nit, a per-socket delivery map entry that was never deleted, was fixed in the merge commit.

## Design

Frames reuse a 2 s grant per participant and authorization reference, looked up outside the `exclusive` queue and shared between concurrent callers. `refresh()` and `disconnect()` bump a synchronous access epoch and drop cached and in-flight grants, so a revocation, an `accessFence` or a role downgrade stops the next frame. A frame whose grant predates the epoch is retried, three times at most, then rejected. Admission is split into a lookup outside the queue and a commit inside it, and the commit refuses if the epoch moved. The production alarm and `askPresence` call `revalidate()`, which looks up off the queue and keeps warm grants. Frames from one socket are delivered in order.

## Nits left

- Grant age counts from lookup completion, so the bound without a refresh call is 2 s plus the lookup time.
- Renewal still runs its admission lookup inside `exclusive`, and fails on any epoch bump during it.
- Agent and RPC paths (`writer()`, `deckRead`, `deckWrite`, `ensureDeckCell`, `listSuggestions`, `restore`) still call `authorize` inside `exclusive`. They stay uncached for immediate revocation.
- The ticket `jti` is consumed only after the lookups, so a replayed ticket can start parallel lookups.
- `rememberGrant` has no monotonic check, and two revalidates in one epoch are not ordered.
- A hung lookup stalls that socket's frames with no bound on queued bytes.
- `checkpointActor` now records the last lookup, not the last writer. The per-write provenance is unchanged.

## Ideas beyond scope

Move the uncached agent and RPC `authorize` calls off the queue with the same epoch pattern. Peek the ticket `jti` before lookups. Make the epoch per participant.

## Steps for Dom

None. Measure on staging after deploy: one-character and three-character peer latency and eight concurrent admissions, as in LR.7 round 3.
