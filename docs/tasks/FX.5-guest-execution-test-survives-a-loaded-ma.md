---
id: FX.5
title: "The guest execution test survives a loaded machine"
milestone: FX
size: S
status: in_progress
depends_on: [FX.4]
branch: null
lane: e2e-scripts
executor: claude
---

FX.4's dispatcher saw `guest-execution.test.ts` (apps/web) fail twice in full `bun run test` runs with a Miniflare `ECONNRESET`, at a load average of 70 or more. It passes when run alone.

## Scope

- Find why the test's Miniflare connection resets under load: a startup race, a too-short timeout, or a shared port. Fix the cause in the test or its helper, not by retrying blindly. FX.1 fixed similar workerd flakes, so read its task file and review first.
- If the cause is pure slowness, give the test a timeout that fits a loaded machine, with a comment saying why.
- Don't change what the test asserts.

## Check

- The test passes 10 times in a row while another `bun run test` runs alongside it.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-21: added by controller from the FX.4 report.
- 2026-11-21: dispatched.
