# SP.6 review

Round 1 (head 6a81bf34, task commit f8338339): clean. Check, test and build passed. Disabling the new `enforceCap` call made the new test fail, so the test covers it.

## Nits left

- `dream/run.ts` swallows an `enforceCap` error silently. `runs.ts` logs it with `console.error`.
- The test uses a one-cent cap and relies on cent rounding ($0.00499 prior plus the fake dream's $0.00002), not the $0.99 of $1.00 in the task, because the fake dream costs a few millionths of a dollar.
- The test asserts `pausedReason: "spend_cap"` but not the Needs you card. `desk.ts` builds the card from that reason.

## Beyond scope

- Log cap-check failures after a dream the way `runs.ts` does.

## For Dom

- The task's walkthrough with seeded dream rows was not run in a browser. Repeat it once against a seeded workspace if you want the live check.
