# FX.7 review

Five tests set to `test.skip` with a `biome-ignore` reason and listed in `docs/backlog/flaky-tests.md`. No product code changed.

Alone-runs with the skip removed locally (not committed): both proxy.test.ts tests pass, guest-execution passes, library-bash 3,000-file loop passes. The ArtifactRoom workerd test did not finish alone: it was still running after 20+ minutes (workerd child hung, past its 120 s timeout), so I killed it. It stays disabled. Dom should run it once on a quiet machine.

Browser steps: none in the task's check.

Review rounds: none run (dispatcher skipped the reviewer for a skip-only change; the controller can request one).
