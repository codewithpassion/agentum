---
id: LR.5
title: Live deck compaction and incremental migration validation
milestone: LR
size: L
status: done
depends_on: [LR.3]
branch: task/LR.5-live-deck-compaction
lane: services
executor: claude
---

Fixes open findings A1, A2 and A3 of review A in `docs/reviews/tasks/LR.3.md` (packages/live-deck: `migrations.ts`, `index.ts`). Live decks run Yjs with `doc.gc = false` so position migrations can reference deleted items. Lifetime caps over the whole retained history, unvalidated deleted payloads and full-history revalidation on every commit let an authorised editor make a deck permanently uneditable or slow.

## Scope
- Write a short design note first in `docs/reviews/tasks/LR.5.md`.
- Compaction: rebuild the deck doc from live state, keeping only ancestry that current migrations reference. Trigger it at checkpoint and when a deck nears its caps. Connected peers resync to the compacted doc without losing concurrent edits or accepting stale updates against the old doc.
- Incremental validation: validate only the records an update adds, once per commit. Caps apply per checkpoint window, not per lifetime.
- `restore()` resets migration state and works after compaction.
- Close the review's test gaps and nits where cheap: caps, `within` depth, cross-fragment spans, `restore` with hostile roots, gc:true peers, overwritten-not-only-deleted payloads, target/source type checks (migrations.ts:197).

## Check
- Failing tests first for: the 200-toggle 10k-character text case (A1), deleted-payload bloat toward the 16 MB scene limit (A2), validation cost bounded by update size rather than history (A3), restore after compaction, peer resync during compaction.
- Existing live-deck tests and the deck browser peer matrices in `L.ACTIONS.md` still pass.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-28: created from LR.3 review A; dispatched (Sonnet dispatcher, Haiku workers, Sonnet reviewer). Dom: before production.
- 2026-10-28: merged at 2ac334aa, review clean after 1 fix round. Deviation: in-place compaction (ids and clocks kept), no peer resync; updates built on removed ancestry are refused whole.
