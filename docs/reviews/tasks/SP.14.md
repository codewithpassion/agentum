# SP.14 review

## Verdicts

Round 1 (658d941a): clean, no must-fix. Zero fix rounds.

## Nits left

- `packages/services/src/managed/service.ts` `interrupt`: the usage read does not apply the guard that `abandon` uses (session open and still serving this run). In the take-over race, a late interrupt can charge the cancelled run with part of the next run's share. The total stays right, because the next run's baseline starts from those totals.
- `packages/services/src/managed/managed.test.ts`: the fake `getUsage` answers whether or not the session is closed, so the managed test does not pin "read before abandon".
- `apps/web/src/server/pi-run-core.test.ts`: the first `cancel` test injects a refusing `complete` and still expects `completed` to be `[]`. The usage-carrying completion is pinned by the test after it. `aborted` is now `toContain("run-1")`, because the `gone` path aborts a second time.

## Beyond the scope

- A cloud run that ends while the platform refuses every flush and has no usage in its slice sends no completion at all. That is intended, since a completion without usage would only be refused.
- Nits 3 to 5 and round-1 nits 4 to 9 of `docs/reviews/SP-2.md` stay open, as the controller decided.

## Steps for Dom

None.
