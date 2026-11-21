---
id: FX.7
title: "Disable the tests that fail only on a loaded machine"
milestone: FX
size: S
status: ready
depends_on: []
branch: task/FX.7-disable-the-tests-that-fail-only-on-a-lo
lane: e2e-scripts
executor: claude
---

Dom's decision (2026-11-21): disable the flaky tests instead of fixing them one by one. Merge checks run while several dispatchers test on the same machine, and these tests fail only then. They pass when run alone. This replaces FX.5 and FX.6, which move to the backlog.

## Scope

Turn off these tests in the default `bun run test`:

- `apps/web/src/server/routes/proxy.test.ts`, the `refreshing` describe: "a lease holder that dies leaves a lease that expires in 30 s, and the next caller takes it" and "--fail-once with no refresh token sets needs_auth and appends connector.needs_auth".
- `apps/web/.../guest-execution.test.ts`: the test or tests that fail with a Miniflare `ECONNRESET` under load.
- The workerd suite: the ArtifactRoom admission test and the library-bash 3,000-file loop test, which timed out in DR.13's run.

For each one:
- Use `test.skip` (or `describe.skip` for a whole block) with a `biome-ignore` comment if the linter requires it. The reason must read: "flaky under load, disabled by FX.7, see docs/backlog/flaky-tests.md".
- Leave the test body as it is, so it can be turned back on.
- Add one line per test to a new file, `docs/backlog/flaky-tests.md`: the file, the test name, the failure seen, and how to run it by hand.

Don't disable anything else. Don't change product code.

## Check

- `bun run check && bun run test && bun run build` pass.
- Each disabled test still runs and passes alone, with the skip removed locally (not committed). Note the result in the review file.

## Log
- 2026-11-21: added by controller on Dom's decision to disable load-flaky tests.
- 2026-11-21: dispatched. Ready at 5465a9d2. The dispatcher skipped its reviewer, so the controller ran a fresh Opus diff review: clean, 3 nits. The ArtifactRoom test did not pass even alone, so it is a broken test, not a load flake. It stays disabled and is tracked in docs/backlog/flaky-tests.md.
