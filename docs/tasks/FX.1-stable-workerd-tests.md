---
id: FX.1
title: "Stabilise the two live-artifacts workerd tests"
milestone: FX
size: M
status: in_progress
depends_on: []
branch: task/FX.1-stable-workerd-tests
lane: live-artifacts-tests
executor: claude
---

Dom asked on 20 Nov 2026 for these to be fixed. Two tests in `apps/web/src/server/live-artifacts/` fail most full `bun run test` runs on this host while other worktrees build, and sometimes alone:

- `guest-execution.test.ts`: "guest execution: HTTP cap/start, durable recovery, signed MCP and suggestions". It fails with `UND_ERR_SOCKET` / `ECONNRESET` ("other side closed") from workerd after 45 to 100 s. The log also shows "Offering the next run of agent a1 failed: Not allowed: runs.guest_access".
- `room.test.ts`: "ArtifactRoom admission, Yjs validation, SQLite, restart, awareness and checkpoint recovery in workerd". Seen failing once in a full run, passing alone.

It failed the same way on commits from before any v4 merge, so the cause is in the tests or their fixtures, not in v4 code. LR.17 (room admissions in the Durable Object) is a separate open task; don't fix it here.

- `packages/services/src/runs.test.ts`: "an hour of never-claimed runs stays bounded and the sweep still reaches a crash-left run". It times out at 65 to 78 s in full runs under load and passes alone (added 20 Nov).

## Scope

- Find why each test fails under load: a fixed port, a timeout too short for a busy host, a workerd process restart race, or a real ordering bug the load exposes. Write down the cause in the review file.
- Fix the cause in the tests, their fixtures (`fixtures/guest-execution-runner.mjs`, `fixtures/bundle-guest.ts`) or, if the load exposes a real bug in live-artifacts code, in that code with a test.
- Don't skip, quarantine or loosen an assertion to make it pass.

## Check

- Each test passes 10 times in a row alone (`bun test <file>` in apps/web).
- Three full `bun run test` runs from the worktree root pass in a row while a parallel `bun run build` runs in another worktree.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added on Dom's request after these tests failed most merge checks of the v4 build.
- 2026-11-20: dispatched on task/FX.1-stable-workerd-tests (v4 controller session).
- 2026-11-20: scope adds the services never-claimed-runs timing test, which now fails most full runs under load.
