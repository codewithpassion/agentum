# FX.4 review

Round 1 at 11343b14: clean. No must-fix findings.

## Tests given a 60s timeout

- `apps/web/src/server/app-gateway/exports.test.ts` (the test that timed out in the SL.13 merge check)
- `apps/web/src/components/agent/room/tab-imports.test.ts` (walks the room folder and parses every import)
- `scripts/memory-sole-writer.test.ts` (walks every `src` file in apps and packages; added after the reviewer's nit, outside the task's wording but the same kind of test)

Assertions are unchanged. Biome reindented the test bodies, so the diff is larger than the change.

Not given a timeout, because they list one directory or read a few files: `find-registry.test.ts`, the packages/db migration tests, `teams-contract.test.ts`, the packages/protocol fixture tests, `a2a-isolation.test.ts`.

## Nits left

- The same `SOURCE_SCAN_TIMEOUT_MS` constant sits in three test files. Left as is; each file stands alone.

## Beyond scope

- `apps/web/src/server/live-artifacts/guest-execution.test.ts` failed once in a full `bun run test` at load average near 70 (`fetch failed`, ECONNRESET after 53s) and passes alone. It is a flake under load, not a source scan. Worth its own task if it recurs.

## For Dom

Nothing.
