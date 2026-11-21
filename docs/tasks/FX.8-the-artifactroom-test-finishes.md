---
id: FX.8
title: "The ArtifactRoom test finishes"
milestone: FX
size: S
status: ready
depends_on: []
branch: task/FX.8-the-artifactroom-test-finishes
lane: e2e-scripts
executor: claude
---

FX.7 disabled the ArtifactRoom test in `apps/web/src/server/live-artifacts/room.test.ts`. Unlike the other four disabled tests, it does not pass even when run alone. FX.7's dispatcher ran it alone with the skip removed, and it was still running after more than 20 minutes, against a 120 s timeout. So it is broken, not just slow on a busy machine. See `docs/backlog/flaky-tests.md`.

## Scope

- Run the test alone once, with the skip removed and a hard outer limit (for example `timeout 300 bun test ...`). Find where it hangs: an awaited promise that never settles, a workerd or Miniflare instance that never starts or stops, or a socket left open.
- Fix the cause in the test or its helper, then turn the test back on and remove its line from `docs/backlog/flaky-tests.md`.
- If the hang is in product code, not the test, report it as a finding with file:line and leave the test disabled.
- No stress tests, no load generators, and no full test runs.

## Check

- `bun test src/server/live-artifacts/room.test.ts` from `apps/web` passes within its timeout, three times in a row.
- `bun run check` and `bunx turbo run test build --only --filter="[origin/main...HEAD]"` pass.

## Log
- 2026-11-21: added by controller for the end-of-v4 test pass.
- 2026-11-21: dispatched.
- 2026-11-21: ready at f485c433, review clean after 1 fix round. The test passed alone 6 times in 52 to 68 s, so it is back on, with two guards that make a stuck run fail instead of hang.
