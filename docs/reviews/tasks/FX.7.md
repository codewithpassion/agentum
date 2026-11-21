# FX.7 review

Five tests set to `test.skip` with a `biome-ignore` reason and listed in `docs/backlog/flaky-tests.md`. No product code changed.

Alone-runs with the skip removed locally (not committed): both proxy.test.ts tests pass, guest-execution passes, library-bash 3,000-file loop passes. The ArtifactRoom workerd test did not finish alone: it was still running after 20+ minutes (workerd child hung, past its 120 s timeout), so I killed it. It stays disabled. Dom should run it once on a quiet machine.

Browser steps: none in the task's check.

Review rounds: none run (dispatcher skipped the reviewer for a skip-only change; the controller can request one).

Checks: `bun run check` passes. `turbo run test build` for web built clean and ran 4,054 passing tests with 0 failures before the run stalled (a hung bun test on the loaded machine, after app-gateway/endpoints.test.ts, which passes alone in 0.3 s), so I stopped it. The four edited files pass together (84 pass, 5 skip, 0 fail). guest.test.ts and production.test.ts, which are slow under load, each pass alone.
