---
id: A.7
title: Thread fold for artifacts
milestone: A
size: S
status: in_progress
depends_on: [A.1]
branch: task/A.7-thread-fold
lane: protocol-thread
executor: claude
---

Spec: `docs/v3/artifacts-prd.md` (the PRD). A.1 holds every schema change, shared constant, protocol schema and seam; this task changes none of `packages/db/src/schema`, `packages/db/src/shared.ts` or migrations, and works against A.1's types. Integration branch: `v3/artifacts`.

## Scope
- `packages/protocol/src/thread.ts`: fold `artifact.published` into an `artifact` part (`ArtifactThreadPart` from A.1) placed after the tool call that made it (by `toolCallId` when present, else at the event's position), in both `foldThread` and `applyFrame`. A later version of the same artifact in the same run updates the part's version rather than adding a second card.

## Check
- Fold tests for replay, live frames, dedupe, a second version and a reload mid-run.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: planned (controller).
- 2026-10-27: dispatched.
