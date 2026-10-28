# LR.8 review

## Verdict

Round 1 at 6cc1bdc7: clean, no must-fix items.

## Why it was not caught earlier

The live-room and export tests inject fake auth, so none called the real Clerk `authenticateRequest`. Local browser runs use the dev instance with the key in the process env, which hid the missing option. Deployed Workers have no such env fallback, so the call throws there. The new `auth.test.ts` calls the real SDK, which closes the gap for `requestClerk`.

## Nits left

- The first test in `auth.test.ts` exercises the SDK, not `requestClerk`. It documents the failure. The second test is the guard.
- Nothing forces a future `createClerkClient` + `authenticateRequest` pair through `requestClerk`. Only the helper's comment does.

## Beyond scope

- `guest-execution.test.ts` takes about 80 seconds and timed out once in a full parallel run. It passed alone and on the rerun.

## Steps for Dom

None. Redeploy staging and rerun the LR.7 live-room and export checks.
