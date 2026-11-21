---
id: FX.4
title: "Source-scan tests survive a loaded machine"
milestone: FX
size: S
status: in_progress
depends_on: []
branch: null
lane: e2e-scripts
executor: claude
---

The SL.13 merge check failed once on `apps/web/src/server/app-gateway/exports.test.ts`: "every source compose caller that can finish a run passes exports and defer" timed out after 5000ms. The test parses every source file in apps/web with the TypeScript compiler. It passes on its own in about a second, but at a load average near 36, with six dispatchers running checks, it went past bun's default 5s timeout.

## Scope

- Give this test an explicit timeout that fits a loaded machine (for example 60s), with a one-line comment saying why.
- Find the other tests that scan the source tree the same way (Glob over the source plus `ts.createSourceFile`, or reading every file) in apps/web and packages, and give them the same treatment. List them in the review file.
- Don't change what the tests assert.

## Check

- The listed tests pass with `bun test <file>` and under `bun run test`.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-21: added by controller after the SL.13 merge check timed out on this test.
- 2026-11-21: dispatched.
