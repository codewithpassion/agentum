# LR.6 Tell a deck editor when their offline changes were refused after compaction

## Design note

`item()` and `fragmentFor` in `packages/live-deck/src/migrations.ts` throw `StaleAncestryError` when an update names history compaction collected (a `GC` struct, or a fragment left as an Item with dropped content). The message is the shared constant `DECK_STALE_ANCESTRY` from `@repo/protocol/deck`. `room-rejection.ts` maps the error to that reason in the room's existing `error` control, and the client keeps the reason. `deck-page.tsx` then shows `DeckRefusalNotice` (shadcn Alert and Button) with a reload button that starts a fresh room. Nothing retries: reconnecting stays a user action. The client now queues the socket `onclose` failure behind unread frames, so the refusal reason is not replaced by "Room disconnected". The cap-overflow probe in `stage()` rethrows the stale error instead of hiding it.

## Review

Round 1 (057e9a0, Sonnet reviewer): not clean, one must-fix. A fragment compaction left as an Item with dropped content still produced the generic refusal. Fixed in b945e9c with a test that fails without the fix. Nits 2 (probe swallowed the stale error) and 5 (notice wording) were also fixed.

Round 2 (b945e9c, fix commit only): clean.

## Checks

`bun run check` and `bun run build` pass. `bun run test` passes except `src/server/live-artifacts/guest-execution.test.ts`, which fails the same way on an untouched main checkout in this environment (workerd fetch failed). New tests: stale-ancestry refusal types in `packages/live-deck/src/compaction.test.ts` (two cases), `room-rejection.test.ts`, the refusal path in `room-provider.test.ts`, and `deck-refusal-notice.test.tsx`.

## Nits left

- No test covers the probe rethrow in `stage()`.
- No test covers the `deck-page.tsx` wiring (typed error selects the notice, button bumps `attempt`).
- `room-rejection.test.ts` does not cover the `DocumentError` and 8 MiB branches.
- `StaleAncestryError` fires for any `GC` struct, including a gc:true peer's collected ranges, so a buggy record could get the stale notice.
- The `onclose` change delays "Room disconnected" while a policy fetch is stuck.

## Ideas beyond the scope

- A browser or workerd room check that drives a real stale-ancestry refusal end to end.

## Steps for Dom

None.
