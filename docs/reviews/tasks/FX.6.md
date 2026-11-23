# FX.6 review

Connector refresh tests are stable under load.

## Cause

"a lease holder that dies..." slept 50 ms and assumed the first call held the lease, then cleared `onTokenRequest`. Under load the call reached the token endpoint late, so the lease row was still empty (`NaN`) and the call went on to make a real refresh against the next test's stub. That leaked call is the 1 token call the "--fail-once with no refresh token" test saw. The second test needed no change. No other test in the `refreshing` describe shares the cause: the rest await every call they start.

## Fix

The first test now waits until the holder is inside the token endpoint call, which happens after the lease write. Both `.skip`s are gone and both entries are out of `docs/backlog/flaky-tests.md`. `proxy.test.ts` passed 51 of 51 five times in a row, alone.

## Verdicts

Round 1 (57a6f425): clean, no must-fix.

## Nits

- Left: `toStub` reads the module-level `stub` at fetch time, so a test that leaves a call running could hit the next test's stub. Binding the stub per test would guard it. Out of scope.
- Fixed: a comment saying why the holder's call stays pending.

## Browser steps

None in the task's check, none skipped.

## Steps for Dom

None.
