---
id: LR.6
title: Tell a deck editor when their offline changes were refused after compaction
milestone: LR
size: S
status: done
depends_on: [LR.5]
branch: task/LR.6-deck-offline-refusal-notice
lane: web
executor: claude
---

Since LR.5 (`docs/reviews/tasks/LR.5.md`), a deck update built on ancestry that compaction removed is refused whole. Dom accepted that behaviour (28 Oct 2026) on condition the editor is told.

## Scope
- The server's refusal carries a distinct, typed reason the client can recognise (reuse an existing error channel if one fits).
- The mounted deck editor shows a clear notice: their offline changes couldn't be applied, reload to continue. Reload brings them back to the current deck. Use existing shadcn/app components.
- No silent retry loop on that refusal.

## Check
- Test that a stale-ancestry update produces the typed refusal and the client surfaces the notice (unit or room test plus a component test).
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-28: created from Dom's decision on LR.5; dispatched.
- 2026-10-28: merged at d59e7c8e, review clean after 1 fix round. Full test passes on main (guest-execution workerd failure seen in the worktree did not reproduce).
