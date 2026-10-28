---
id: LR.12
title: Deck room applies peer frames without a policy fetch per frame
milestone: LR
size: M
status: done
depends_on: [LR.10]
branch: task/LR.12-deck-room-latency
lane: web
executor: claude
---

LR.10 (`docs/reviews/tasks/LR.10.md`) removed the per-frame HTTP policy fetch from the document room but reverted it for the deck room: applying frames with a cached policy broke concurrent same-cell table typing in the deck browser matrix in 3 of 7 runs (0 of 5 before). Deck peer edits still take 2 to 20 s on staging.

## Scope
- Find the table-cell race first (it is likely a real ordering bug the slow fetch was hiding), fix it, then apply inbound deck frames without a per-frame round trip. Access loss still stops the room.

## Check
- A deterministic test for the race. The deck matrix's concurrent same-cell typing passes 10 of 10 runs at 1280x800 and 390x844.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-28: created from LR.10.
- 2026-10-28: dispatched; production does not wait for it.
- 2026-10-28: scope added from LR.7 round 3: deck toolbar controls are 33px at 390px, need 40px (deck-editor.css:361).
- 2026-10-29: merged at a02b486a, review clean; shared empty cell text node, cached deck policy, 40px deck toolbar (toolbar and one nit after review). Open: backfill for untouched empty cells.
