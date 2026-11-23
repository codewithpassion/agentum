# DR.14 review

Verdict: clean on round 1 (reviewed 687d9ef4), 0 fix rounds.

## Nits left

- The Knows tab (`apps/web/src/components/agent/room/knows/index.tsx:18`, `dream/held-batch.tsx:39`) still shows Approve and Reject only to the owner or an admin, so the backup sees no buttons there. The rail card does show them.
- `dream/held.ts` repeats the owner, creator and backup filter of `decidableAgentIds` in `desk.ts`.
- `deciderSession` copies `ownerSession` with a different guard.

## Ideas beyond the scope

- Let the Knows tab use the decider rule for held dream batches, as the rail does.

## Skipped

- No browser step was in the task's check, so none was skipped.

## Steps for Dom

None.
