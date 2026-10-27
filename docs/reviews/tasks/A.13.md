# A.13 Thread card for artifacts

Verdict: clean after 0 fix rounds. Round 1 reviewed d703896 and found no must-fix items.

## Check status

Component tests (part mapping, card desktop and phone variants), `bun run check`, `bun run test` and `bun run build` pass. The browser check for R1.22 (a run's artifact shows live and after reload) did not run. `v3/artifacts` had none of A.2, A.3, A.6 or A.7 when this task finished, so `artifacts.open` is still a stub and the fold has no artifact part. That check moves to A.14.

## Notes for integration

- `thread-parts.ts` widens `assistantContent` to `ThreadPart | ArtifactThreadPart` because A.7 has not added the part to `ThreadPart`. Once A.7 is merged the widening is redundant and can go. The two tests in `thread-parts.test.ts` cast their parts array for the same reason, and the casts can go too.
- The card calls `artifacts.open` as a mutation (`surface: "thread"`, the part's version) once per mount, after the card first scrolls into view, on desktop only. Phones load `/api/artifacts/:id/thumbnail?version=<n>` (A.6) and fall back to the kind icon when it fails.
- Open links to `/a/<artifactId>` (A.8's viewer route) with a plain anchor.

## Nits left

- `isArtifactKind` uses `in`, which accepts prototype keys. Use `Object.hasOwn`.
- Resizing across 768 px calls `artifacts.open` again, which writes a second `thread` view row. A "opened once" ref would stop it.
- Phones paint the desktop skeleton first, because `useIsMobile` is false until mount.
- The preview turns non-interactive again only on `mouseleave`, so touch and keyboard users stay in it. Clicking the overlay also drops focus.
- An `artifacts.open` error leaves the skeleton with no message.
- `expiresAt` from `artifacts.open` is ignored, so a thread tab left open past the token's life cannot navigate inside the frame.
- `artifactId` is not URL-encoded in the href and thumbnail src (it is a uuid from the fold).
- The Open icon suggests a new tab, but the link opens in place. The anchor could become a router `Link` once `/a/$artifactId` exists.
- The thumbnail has no `loading="lazy"`. `cn("size-full")` wraps one class.
- No test covers `ThreadCard`'s open logic (surface, version, no call on phones).

## Ideas beyond scope

- Refresh the content URL when `expiresAt` nears, and offer a retry on open errors.
- Collapse older artifact cards in a long thread to a one-line row.

## Steps for Dom

None.
