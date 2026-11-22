# HM.2 review

Verdict: clean in round 1 (commit 3135d3fa), no fix rounds.

## Nits left

- The test does not assert the bottom-line shadow class, so dropping it would pass.
- The shadow uses `var(--color-border)`, which works because Tailwind emits the inline theme variable when referenced. `var(--border)` would point at the source variable.
- With the scrollbar hidden, nothing signals off-screen tabs on narrow, mouse-only setups. This is the trade-off the task asks for.

## Ideas beyond scope

None.

## Skipped browser steps

The task check has no browser step. The underline-on-bottom-line look and sideways scroll were judged by review only, so check them once in the browser pass.

## Steps for Dom

None.
