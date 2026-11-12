# CL.6 review

Round 1 at cc646a2d: clean, no must-fix.

## Nits left
- A bucket error returns no notice in `compose.ts`, but only `outdatedVersions` rejecting is tested, not the wrapper.
- `versions` is capped at 100 in the router, so a workspace with more than 100 distinct client versions would fail the Machines loader.
- The outdated query waits for `machines.list` and reads `latest.json` a second time.
- `version !== latestVersion` in `isDaemonOutdated` is redundant, the server never lists the latest.
- The optional `product` input on the new procedure has no caller.
- A version is dated by its first binary (`agentum-linux-x64`) only.

## Beyond scope
- Republishing an old version gives its binaries a fresh upload time, so machines on newer builds would be offered the rollback.

## Steps for Dom
- None. After the staging deploy, check the Machines page shows no notice for both Morosini instances. Production waits for your go.
