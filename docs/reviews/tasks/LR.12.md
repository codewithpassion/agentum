# LR.12 review

Deck peer frames apply from a cached policy, the table-cell race behind the LR.10 revert is fixed, and deck toolbar controls are 40px at 390px.

## Verdicts

Round 0 (reviewer on 910be36b, sonnet high): clean, no must-fix. The dispatcher applied the stale-ticket nit afterwards and added the toolbar change (scope added by the controller).

## The race

Two writers typing first into the same empty table cell each created their own text node inside the cell's paragraph. The editor binding merged the two and dropped one writer's later text. The per-frame policy fetch only hid it by timing. Empty paragraphs written into cells now carry a shared empty text node (`seedEmptyParagraphs` in `packages/live-deck/src/index.ts`), so both writers type into the same node. Tests in `editor.test.ts` drive two real Tiptap editors through 16 sync schedules: the seeded cell keeps every character in all 16, a cell without the node loses text in all 16.

## What changed

The deck room applies inbound frames after sync from the cached policy and refreshes it in the background (coalesced, stale responses dropped, 30 s timer). The first sync and any update whose bytes hold `/files/` or `artifact:` still wait for a fresh manifest. Access loss is unchanged and a background policy failure stops the room. At 390px, `.ld-toolbar` buttons, selects and inputs have `min-height: 40px` (were 33px); desktop is unchanged. The real-room browser check measures both.

Browser matrix (`room-browser-check.ts`, both viewports per run): 12 of 12 passed with the fix, 5 of 6 failed with cached frames and no seed.

## Left as is

- Cells already stored as empty paragraphs (untouched cells of existing tables) are not seeded until something rewrites them, so they keep the race. A backfill would fix them.
- Seeding is shallow. An empty paragraph inside a list item and empty text elements keep the same race shape.
- Every cached frame schedules a refresh, so continuous typing causes back-to-back policy fetches. A trailing throttle of 1 to 2 s would cut that.
- The blob byte scan allocates a closure per byte per marker; a first-byte check would be cheaper for very large updates.
- The blob test uses `/files/` in plain text, and nothing covers the `artifact:` marker directly.
- `guest-execution.test.ts` is known to time out under load.

## Steps for Dom

None. Staging should re-measure deck peer edit latency and the toolbar target size after deploy.
