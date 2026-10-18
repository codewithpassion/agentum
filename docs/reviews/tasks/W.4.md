# W.4 review

## Verdict

Round 1 at 4251ab4: clean, 0 fix rounds. Nothing was must-fix.

## Notes

- Finding 1 was "must-fix or confirm intended". A VM session now refuses `[ATTACHMENT:/library/...]`, because the task says to refuse paths outside `/workspace` and `/tmp`. Before W.4 those markers were read from the library. The VM prompt still tells the agent to reach the library with the library tools, so a VM agent that wants to return a library file has to copy it into `/workspace/home` first. Left as the task states it.
- The second scope bullet (no `/library` in the VM's attachment text) was already true on main from W.1 and W.2, so no code changed for it. `filesExtension` has no prompt section, and the VM section is tested in `linux-vm/vm-tools.test.ts`. Only the header comment of `pi-run-files.ts` was updated.

## Nits left

- `packages/mcp/src/tools/library.ts:24,44`: the platform library `bash` tool says the library is mounted at `/library`. It is the one `/library` text a VM session still sees, and it invites a marker that is now refused.
- `apps/web/src/components/agent/agent-form.tsx:215`: help text for the cloud runtime still tells people to use `[ATTACHMENT:/library/path]`. Out of date for VM agents.
- `pi-run-files.ts` `vmReader`: a path whose `stat` kind is `symlink` reports as missing. The fake VM never returns a symlink, so no test covers it, and it is not known whether the Sandbox SDK `stat` follows links.
- `VM_SCRATCH_ROOT` in `pi-run-files.ts` repeats `SCRATCH_DIR` in `linux-vm/vm-tools.ts` and `TMP_DIR` in `linux-vm/vm-env.ts`. One export in `vm-port.ts` would keep them together.
- No test covers the VM branch of `outputsOf` in `pi-run.ts`, only `uploadVmOutputs`.

## Ideas beyond scope

- Let a VM agent return a library file by marker, by reading `/library/...` through the library service as the isolate does.

## Steps for Dom

- Live on staging: a VM agent returns a file from `/workspace/home` as a chip in the chat (the controller's check).
