---
id: DR.13
title: "Dream with a scripted model on local"
milestone: DR
size: S
status: done
depends_on: [DR.7]
branch: null
lane: services-dream
executor: claude
---

From the dream walkthrough (`docs/reviews/DR-e2e.md`).

## Scope

when `devFakeRuntime` is on, route the dream's model calls to a scripted judge (the one in `dream/test-dream.ts` is a start) that answers from a small fixture.

## Check

Dream now on a seeded agent with no key gives the same diary, a question and a held batch every time, and a production build refuses the switch (a test, as `compose-a2a.test.ts` does for loopback).
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the dream walkthrough.
- 2026-11-21: dispatched.
- 2026-11-21: deferred to the backlog on Dom's scope freeze (only must-fix bugs stay in v4).
- 2026-11-22: back in scope on Dom's call (all deferred tasks except the flaky-test fixes).
- 2026-11-22: dispatched.
- 2026-11-22: merged at 47e109f3, review clean after 0 fix rounds.
