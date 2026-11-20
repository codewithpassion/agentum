# FX.2 review: Turbo caches test results per package

## Verdict per round

- Round 0, c65937ef: not clean. One must-fix: `scripts/merge-check.sh` ran only `turbo run test`, so the memory sole-writer guard, moved to `scripts/` by this task, left the merge gate.
- Round 1, 42e560a4 (fix commits only): clean. `merge-check.sh` now runs `bun test ./scripts` after turbo and folds its result into the `TEST` code.

## What changed

- `turbo.json`: `test` is cached, with `dependsOn: ["^test"]`, `$TURBO_DEFAULT$` inputs, and exclusions for `.turbo`, `.wrangler`, `node_modules`, `target`, `dist`, `.output`, `coverage`, logs, `*.tsbuildinfo` and `worker-configuration.d.ts`. `outputs` is empty.
- Turbo does not hash an upstream package into a dependent unless the task has `dependsOn: ["^test"]`, so a dependency change re-runs its dependents only through that edge.
- Files a package's tests read outside the package are declared in a per-package `turbo.json` that extends the root one:
  - `apps/web`: `.github/workflows/agentum-images.yml`, `apps/agentum/README.md`, `apps/agentum/packaging/**`, `scripts/dev/**`.
  - `packages/services`: `scripts/dev/**`.
  - `packages/protocol`: `apps/agentum/testdata/protocol/**`.
  - `apps/agentum` (agentum-rs): `packages/protocol/fixtures/**`, `packages/library-sync/src/**`.
- Turbo hashes the root package's internal dependencies into every task's global hash. The root depended on `@repo/db`, `@repo/protocol` and `@repo/services` for the scripts in `scripts/`, so any change in those three or in their dependencies busted every cache. Those three dependencies moved to a new `scripts` workspace (`scripts/package.json`, name `@repo/scripts`, no tasks). `bun.lock` was edited by hand for exactly that move, so it carries no unrelated version bumps.
- `packages/services/src/memory/sole-writer.test.ts` scans every package's source. As a services test it would have made every source change in the repo invalidate services and its dependents. It moved to `scripts/memory-sole-writer.test.ts`, which runs uncached on every `bun run test` and in `merge-check.sh`.

## Measured

- Cold `bun run test`: 10m47s on a host at load 12 to 18, 14 packages.
- Second `bun run test`, nothing changed: 14 of 14 cache hits, 5.8 s for the whole command including `bun test scripts`.
- `turbo run test --dry=json` after editing one file:
  - `packages/services/src`: misses services, app-gateway, mailbox, hooks and web.
  - an `.rs` file in `apps/agentum/src`: misses agentum-rs only.
  - `apps/agentum/README.md`: misses agentum-rs and web, because web's docker test reads it.
  - `packages/live-doc/src`: misses live-doc, live-deck, live-export, mcp, services and the services dependents.
  - `scripts/dev/stub-mcp.ts`: misses services, web and the services dependents.
  - a stray `.log`, `.wrangler/x.log` or `target/q`: misses nothing.

## Never cached

No package turns caching off. The tests that read the network or the clock all go through stubs or a sandbox that blocks egress, so their results depend only on tracked files. Uncached by design:

- Everything under `scripts/` (`bun test scripts`, about 5 s), including `memory-sole-writer.test.ts`, `boundary-lint.test.ts` and the `scripts/dev/*.test.ts` files. `bun test scripts` is a name filter, so it also picks up the apps/web `scripts/` and `skill-scripts/` tests a second time.

## Nits left

- `package.json:22`: `bun test scripts` is a substring filter and runs about 17 apps/web tests a second time, uncached, without apps/web's bunfig preload. `bun test ./scripts` is the exact form, which `merge-check.sh` now uses. Left alone: it predates this task.
- `turbo.json`: `^test` makes dependents wait for their dependencies' tests, so a cold run after a change in db, protocol or services is a serial chain (db, protocol, live-doc, live-deck, mcp, live-export, services, app-gateway, web) where before everything ran in parallel. Listing dependency source globs in `inputs` would hash the same files without the ordering, at the cost of keeping them in sync by hand.
- `scripts/merge-check.sh:11`: the rule that skips agentum-rs when `apps/agentum` is unchanged predates the cache. agentum-rs also reads `packages/protocol/fixtures` and `packages/library-sync/src`, so a merge that touches only those skips Rust tests that could break. With the cache the filter is no longer needed.
- Things outside the repo are not in the hash: the bun version, the Rust toolchain, Chrome (`CHROME_BIN`, used by `packages/live-export` print test), node, `TZ`, and gitignored `.env` files. Upgrading one does not re-run tests until a tracked file changes. `turbo run test --force` bypasses the cache.
- The `@repo/scripts` workspace creates `scripts/node_modules`. The root no longer has `node_modules/@repo/*`.

## Ideas beyond the scope

- Cache `typecheck` and `build` the same way. Both already have turbo tasks.
- Drop the agentum-rs filter from `merge-check.sh`.

## Host flakes seen during the run

Under load 12 to 18 from other worktrees, these failed in full runs and passed alone, as FX.1 describes. A failed task is never cached, so each one forced a re-run.

- `apps/web` live-artifacts `guest-execution.test.ts` (failed 3 times in full runs, passes alone in 136 s).
- `packages/services/src/runs.test.ts` "an hour of never-claimed runs stays bounded..." (65 to 79 s against its 60 s limit in 4 full runs, 174 of 174 passing alone). Every other services test passed (4608 pass, 1 fail).

## Steps for Dom

None.
