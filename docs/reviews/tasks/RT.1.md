# RT.1 review

## Verdicts

Round 1, commit c1e615c: clean, no must-fix.

## Nits left

- `agent-form.tsx`: the Runtime field uses `FieldLabel`, a `<label>` with no control to point at.
- `agent-form.tsx`: the line "Runs on Cloudflare" sits above a description that starts the same way.
- `agent-form.tsx`: for a machine agent the line follows the machine picked in the select below, before it is saved.

## Ideas beyond the scope

None.

## Not verified

- No browser check against the local dev server. The component tests render the Runs on card and the edit form to static markup instead.
- `src/server/live-artifacts/guest-execution.test.ts` failed in the full run and alone here (fetch ECONNRESET in this sandbox). The reviewer saw it pass alone in 95 seconds. The change does not touch that area.
- `agentum-rs` test `version_probe_times_out_without_stalling_runtime` failed once with ExecutableFileBusy under parallel load, then passed on a rerun.
- Staging checks are the controller's.

## Steps for Dom

None.
