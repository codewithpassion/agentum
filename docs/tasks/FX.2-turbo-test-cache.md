---
id: FX.2
title: "Turbo caches test results per package"
milestone: FX
size: S
status: todo
depends_on: []
branch: null
lane: ops-turbo
executor: claude
---

Dom asked on 20 Nov 2026. `turbo.json` has `"test": { "cache": false }`, so every `bun run test` re-runs all 14 packages, even when a change touched one. Each task runs the full suite several times and every merge check runs it again, which costs 6 to 7 minutes a run and loads the host.

## Scope

- Turn on turbo caching for `test`, with `inputs` that cover each package's source, tests, fixtures and config, plus the workspace packages it depends on (`dependsOn: ["^build"]` or `^test` as fits), so a change in a dependency re-runs the dependents.
- Keep anything that must never be cached uncached, for example tests that read the network or the clock in ways the inputs can't see. Name them in the review file.
- Exclude logs, `.wrangler`, `node_modules`, Rust `target/` and generated files from the inputs so they don't bust the cache.
- `scripts/merge-check.sh` keeps working.

## Check

- A second `bun run test` with no changes reports every package as a cache hit and finishes in under 30 seconds.
- Touching one file in `packages/services/src` re-runs `@repo/services` and the packages that depend on it, and no others.
- Touching a file in `apps/agentum` re-runs only `agentum-rs`.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added on Dom's request, from the controller's timing analysis.
