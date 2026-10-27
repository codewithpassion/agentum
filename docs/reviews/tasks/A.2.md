# A.2 review

Task: artifacts core service and router. Branch task/A.2-artifacts-service.

## Rounds

Round 1 (ff9a407): not clean. Three must-fix items. `update` took its version number after slow work, so two updates racing on one base did not hit the unique index. There was no test for that race. `fromLibraryPath` read every file into memory before the 16 MB check.

Round 2 (d261935, fix commit only): clean. The number is now read right after the stale-base check, a `Promise.allSettled` race test fails without that reorder, and the listing sizes are summed before any `library.read`.

## Nits left

- No test pins the early library size check (the later total check in `resolveContent` would still refuse the folder).
- A conflict message after a lost unique-index race reports the max read at the start, not the true current version.
- A refused commit (conflict or quota) can leave its manifest object in R2. D1 holds nothing.
- Rename, audience and delete events use `sessionId: null`, restore uses the artifact's session. Chosen on purpose: restore publishes a version, the others only touch the workspace log.
- An `update` that changes the title writes `artifact.published` and no `artifact.renamed`.
- The quota check and blob writes are check-then-write, so two concurrent creates can pass together and pass 1 GB. D1 has no interactive transactions.
- `canCreateLiveLink` and the read-only key test are written inline instead of reusing `policy.ts` and `automation-access.ts`.
- `get` loads the current version twice.
- A library folder with a `_hm/` file fails the whole publish.
- `test-harness.ts` does not follow the `*.test-helper.ts` naming.

## Beyond the scope

- `ownerName` on cards needs a `people` lookup. The service takes an optional `people` (the same `PeopleLookup` the events service uses); without it `ownerName` is null.
- `madeIn.title` is null. The sessions service holds the title logic.
- Soft-deleted artifacts keep their blobs and still count toward the 1 GB quota until a hard-delete job exists.
- `artifacts.list` filters on a `runId` (A.9's input field) in the service and query. The router passes its input through, so the filter works as soon as the schema has the field.

## Steps for Dom

None.
