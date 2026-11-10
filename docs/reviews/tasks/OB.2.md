# OB.2 review: enrolling a machine, one path that confirms

## Verdicts

- Round 1 at 11aa4bdf: must-fix. `newMachine` counted a just-redeemed (offline) machine as Connected.
- Round 2 at 353511f7 (fix only): clean.

## Nits left

- `knownMachineIds` comes from the page loader, not from the moment the code is made. A machine enrolled elsewhere in between would show as Connected under its own name.
- Polling continues after the code expires, until the dialog closes.
- Adding the computer role to a Go machine gets no Connected confirmation (it watches new machines only).
- A workspace whose machines are all revoked sees an empty table with the toggle off, not the empty state.
- `dialogTitle` takes `object | undefined`, a looser type than needed.
- The dialog test covers the status component and the pure matching helpers. The polling effect itself has no test, because the repo's component tests render static markup with no DOM.

## Ideas beyond scope

- Stop polling at the code's expiry and show "code expired".
- Confirm the computer role on an existing Go machine through `computerStatus`.

## Not verified

- Staging check: enrol a machine and see "Connected" without a reload (the controller's).
- No local browser run of the dialog.
- Full `bun run test` had load-related timeouts on unrelated tests (a services sweep test passes alone in 44s, `guest-execution.test.ts` in apps/web hangs here, one Rust doctor test is flaky under load). None touch this change.

## Steps for Dom

None.
