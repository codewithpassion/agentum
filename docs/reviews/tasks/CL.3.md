# CL.3 Build a run's launch context once

## Verdict

Round 1, commit 7a808eaf: clean, no must-fix. No fix rounds.

## What changed

`runs/launch-context.ts` reads the scoped connectors, model, hand-off names, speaker flag and Slack text once. The cloud runtime, the machine claim and the managed service map it to their own shapes. `runs/launch-context.test.ts` pins the shared context. No behaviour change.

## Nits left

- `LaunchContext.scope` is returned but no adapter reads it. Only the test does.
- The managed service builds the full context before `grantsFor` and the skill-count check, so a failure there wastes three reads.
- The machine claim's connector query no longer runs in parallel with `loadRun` and `findSessionById`.

## Ideas beyond the scope

- The computer lookup differs between cloud (skips revoked machines, tolerant JSON parse) and managed (no revoked filter, bare `JSON.parse`). Merging them would change behaviour, so I left both. Dom may want to decide which rule is right.
- Library roots are built in both the cloud runtime and the machine claim and could join the context.

## Not verified

- Staging checks in the task file belong to the controller.

## Steps for Dom

None.
