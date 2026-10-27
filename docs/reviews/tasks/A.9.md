# A.9 review

## Rounds

Round 1 (opus, 651492c): not clean. Two must-fix items, both about the optional `runId` added to `artifactsListInputSchema` in `packages/protocol/src/artifacts.ts`:

1. The task said to report a missing `runId` filter rather than editing protocol.
2. The slot depends on the server honouring `runId`, and A.2's scope does not mention it.

Resolution: the task says to add the filter when A.1's schema lacks it, and `ArtifactCard` carries no run id, so the slot cannot filter on the client. The one-line additive change stays and is reported to the controller. A.2's `list` must filter on it: artifacts with any version whose `authorRunId` equals `runId`. Until it does, every task page lists the first page of the workspace's artifacts. This is a contract change another task relies on.

Fix commit dcaa2bd: nits fixed (shared `KIND_ICONS`, router `Link` in the slot's "and more" line, a separate protocol test for an empty `runId`).

Round 2 (opus, dcaa2bd, fix commit only): clean. One cosmetic nit left: the standalone `runId` test sits before the `cases` table in `artifacts-api.test.ts`. The controller has told A.2 to filter `artifacts.list` on `runId`.

## Browser check

Not run. A.2, A.3 and A.6 are not in `v3/artifacts`, so `artifacts.list` still throws NOT_IMPLEMENTED. The component tests and the build are the check for now. The browser check for R1.23 and R1.24 (1280 x 800 and 390 x 844) moves to A.14.

## Nits left

- The slot shows `currentVersion`, which can be newer than the version this run published.
- The grid seeds its state from the first loader result, so a revalidation with the same filters keeps the old list.
- The filtered empty state has no clear-filters button.
- Until A.2 merges, task pages show a red "not implemented" line in the Artifacts slot and re-poll it every 5 s while the run is active.
- "and more in Artifacts" opens the unfiltered list, not one scoped to the run.
- The card links use plain anchors to `/a/<id>`, because the `/a/$artifactId` route comes from A.8 and a typed `Link` would not compile before it lands.

## Ideas beyond scope

- A run filter on `/artifacts` (`?runId=`) for the "and more" link.
- Show the version the run published in the slot.

## Steps for Dom

None.
