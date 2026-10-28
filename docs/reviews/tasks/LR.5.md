# LR.5 Live deck compaction and incremental migration validation

## Design note

Fixes A1 to A3 of review A in `LR.3.md`.

**Problem.** Decks run Yjs with `doc.gc = false` so position-migration records can name deleted items. Three things followed. Caps counted the whole retained history (A1). Deleted payloads under meta, sections and slides were never validated or bounded (A2). Every update revalidated the whole history, three times per commit (A3).

**Compaction rebuilds in place, ids unchanged.** The task text suggests a rebuilt doc and a peer resync. A rebuilt doc gets new struct ids, so every in-flight peer update would fail and unsent edits would be lost. Instead `compactDoc` (`compaction.ts`) runs Yjs's own `tryGc` over the authority doc with a filter that spares the items live migration records need. Those are every source and target range, the fragment each root names, and all their ancestors (`liveReferences` in `migrations.ts`). Everything else deleted becomes a collected struct. Kept deleted leaves lose their bytes but stay Items with their parents, which is all `range()` and `within()` read. Client ids and clocks do not change, so state vectors stay valid and connected peers resync nothing. A peer's update that builds on collected ancestry (a record naming items under a deleted, collected subtree) is refused whole, as any invalid migration is, and that peer reconnects. Peers keep their own larger docs, which only affects their memory.

**Windows.** A window is the span between compactions. Incremental validation (`validatePositionMigrations` with `since`) visits only structs at or after the pre-update state vector, so cost follows the update. Window caps keep the old numbers (10,000 records, 100,000 vectors and transfers, 2M positions) and apply to usage added since the last compaction. Live records survive compaction, so a lifetime ceiling of 32 windows also applies. Initial loads (empty doc) skip window caps, since they replay history earlier windows admitted. A cap overflow triggers one compaction and retry, but only if a probe (the same update against a compacted copy with a fresh window) would pass, so a hostile update still leaves the authority byte-identical.

**Once per commit.** `Deck.prepare(update)` validates against one seeded copy and returns the unapplied result. `ArtifactRoom.commitDeck` persists, then calls `apply()`. This replaces three full-history validations. Scene size is estimated from update bytes and measured exactly only above half the limit.

**When it runs.** `saveCheckpoint` compacts first, so stored checkpoints are compact. `commitDeck` compacts when a window passes half a cap (`shouldCompact`). `restore` compacts after the replacement. Each compaction writes a new snapshot generation and drops the update log (`persistCompaction`).

**Restore.** `Deck.restore` now clears every migration root, and resets window and live usage. The room compacts afterwards. That is the recovery path A1 lacked.

**Browser mirrors** pass `compaction: false`: they never open a window, the authority does.

## Review

Round 1 (1163155e, Sonnet reviewer): not clean, one must-fix. After compaction, a deleted fragment under a live parent stays an Item with dropped content, not a collected struct, so `fragmentFor` rejected it and the deck could not reload (snapshot written by `persistCompaction` would not load after a restart). An editor could trigger it by replacing a text element's fragment. Fixed in the fix commit: `wasCollected` accepts both forms, with a reload test that fails without the fix. The reviewer also showed the cap-overflow probe compacted a copy that already held the update, so ancestry the update used stayed alive and the probe could pass where the real retry fails. The probe now compacts the copy before applying the change, matching the real path.

Round 2 (40a38911, fix commit only): clean. Two nits left: no test pins that a root holding payload pointing at a collected item is still rejected (the reviewer probed it by hand), and the probe stages with pre-compaction `live` and `size`, so it could admit an update the real retry then rejects after a harmless compaction.

## Checks

`bun run check`, `bun run test`, `bun run build` pass. The deck real-room runner (`apps/web/src/components/live-decks/fixtures/room-browser-check.ts`, actual ArtifactRoom in workerd, two browsers, 1280x800 and 390x844) passes. New tests: `packages/live-deck/src/compaction.test.ts` (A1 250 toggles of a 10k paragraph, A2 deleted-payload bloat, A3 incremental usage, restore after compaction, hostile restore roots, peer convergence across compaction for gc true and false peers, stale ancestry refusal, gc:true collected payloads, reload after fragment replacement) and four added to `migrations.test.ts` (`within` depth, target type for every destination item, overwritten payloads).

## Nits left

- Probe path: the `dirtyBytes === 0` guard blocks the retry when an update itself frees space (replacing a scene above 8 MB right after a compaction).
- A rejection at the lifetime ceiling still pays a copy, a probe copy, a compaction and an exact encode.
- Per-update cost is still O(roots) (up to 20,000 junk roots) and the candidate copies the whole doc; A3 is bounded for migration validation, not for the copy.
- `persistCompaction` failure surfaces after the commit and broadcast.
- The A3 test checks the incremental scan count, not elapsed cost.
- Missing tests: window and lifetime cap exhaustion through `Deck`, the probe path leaving the authority unchanged, `commitDeck` prepare/apply, `persistCompaction` rollback.
- Not done from the review's nits: `reject()` still carries no reason; `target.boundary` and `source.boundary` are not cross-checked; `applyUpdate` persists the original bytes, so trailing bytes survive until compaction.
- The browser mirror (`compaction: false`) keeps lifetime counters that do not reset when the authority restores.

## Ideas beyond the scope

- Live records never expire, so the lifetime ceiling (32 windows) is a durable limit; recovery is an owner restore. A pruning pass for old records needs a decision on which anchors still need them.
- Persistent validator on the browser mirror, so each local edit validates its delta instead of the whole doc.

## Steps for Dom

None. No accounts or dashboards are involved.
