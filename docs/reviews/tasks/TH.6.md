# TH.6 review: a child that ends always wakes its parent

## Verdicts
- Round 1 (1e5afc10): not clean. A wake into a parent that is itself a subagent would run without the subagent's scope (unrestricted access, default model, invisible to `cancelSubagentTree`).
- Round 2 (150e2b55): clean. Parents that are subagents are not woken.

## What was built
- Every end of a hand-off or subagent child calls `wakeEnded`: `completeRun` (done and failed), the aborted completion, `cancelOwnedRun`, the repeat-stop failure, a third failed download, the lease reaper and the unclaimed-run expiry. The wake keeps TH.4's untrusted framing and `handoff-wake:<child id>` request id, so a child that ends once wakes once.
- A live parent no longer blocks the wake. The wake is queued behind the running run through the parent's own session. A new trusted start option `wakesParent` skips the busy-ancestor refusal, because nobody waits on a wake (`runs/subject.ts` parameter renamed `unawaited`).
- The wake says how the child ended: has finished, has failed, was cancelled, timed out (a lease expiry or a never-claimed run). Non-finished endings carry the error and "Decide what to do next."
- Subagent children now wake. A subagent cancelled by its parent's own cancellation does not wake the cancelled parent.
- Depth limit unchanged. Same-agent hand-offs still wake nothing, which ends wake chains.

## Nits left
- A parent that stops its own subagent with `stopSubagent` still gets a "cancelled" wake.
- No test for the outcome mapping of a machine-aborted child ("has failed") versus lease expiry ("timed out"); only the lease case is checked.
- The task's scope says "always"; the subagent-parent exception is not in the task log.
- A wake for a live parent is also offered to the runtime on start, like any message to a busy session; the claim guard holds it until the parent ends.

## Ideas beyond scope
- Let a subagent parent be woken by starting the wake with the parent's subagent level, scope and model. The subagent guard needs the parent live, so it takes its own design.
- Skip the wake for a child the parent already read with `get_run` or `subagent_status` (needs a "result read" marker, a schema change).

## Not verified
- Staging: an agent hands off, the parent ends or is busy, the wake arrives in the parent's thread (controller's check).
- No browser check; the change is service-only.

## Steps for Dom
None.
