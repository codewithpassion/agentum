# TH.4 review: hand-offs and helpers show as sub-threads

## Verdicts
- Round 1 (7b34251): not clean. Grandchild threads were dropped from the list (fixed in 70c0bfc). The wake fires only for an ended parent (kept, see the question for Dom).
- Round 2 (70c0bfc): not clean on the same wake point only. The coordinator then decided to keep the behaviour and record it as a question.

## What was built
- A hand-off from a private or `ui` session stays private to that session's actor (`newSessionOwner` in `runs.ts`).
- A hand-off child (an `mcp` session started by a run, different agent than its parent) that ends after its parent ended wakes the parent in the parent's own session. The input is framed as untrusted (`runs/handoff-wake.ts`), the request id is `handoff-wake:<child id>`, and the parent's reply target is reused except for `a2a`.
- `runs.reply` (tRPC) calls `runs.replyInSubThread`. It needs a user who can see the session, and the session must have a parent. It uses the trusted `sessionId` option.
- `tasks.get` returns `parent` and `children` (visible threads only, with status). The thread page shows a parent link and child list, and enables the composer for sub-threads. The list nests children under parents up to two levels of indent.

## Subagent wake
The brief says "reusing the subagent wake". The services have no subagent wake: a parent polls with `subagent_status`. The only wake into an existing session is the A2A wake (`a2a/outbound.ts`), which also fires only after the calling run ended. The hand-off wake follows that shape without `wakeOf`.

## Question for Dom
When a child (hand-off or subagent) ends while its parent run is still live, should the parent be woken? Today it is not. The result is lost if the parent sent without waiting, waited past 120 s, or sent several and blocked on one. Waking a live parent would cost a redundant run for every hand-off it already waited on. Fixing it properly needs a "result read" marker, which means a schema change.

## Nits left
- Only `completeRun` wakes; a cancelled or reaped child wakes nothing.
- A wake run is one level deeper than its parent, so wake chains end at `MAX_RUN_DEPTH`.
- `titlesAndStatuses` in `tasks/service.ts` repeats title logic from `sessions.ts` and ignores mail subjects.
- A child session with no runs shows "queued".
- A two-node parent cycle would hide both rows in the list (cannot occur: parents are set at creation).
- The artifact composer guard in `task-thread.tsx` has no test.

## Not verified
- No local browser check of the sub-thread composer or the parent/child strip.
- Staging: an agent hands off, the child shows under the parent, a reply in the child works (controller's check).

## Notes for running checks
The web typecheck runs out of Node heap at the default size (also on the commit before the fix). Use `NODE_OPTIONS=--max-old-space-size=12000 bun run check`.

## Steps for Dom
Answer the question above.
