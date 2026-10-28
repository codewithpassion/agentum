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

## Status

Implementation in progress. Verdicts, nits and steps for Dom are filled in after review.
