# Review: W.2 Linux VM keyed by agent with a persistent /workspace/home

## Verdicts

- Round 1 (f15947f): must-fix. The skills swap deleted the old folder before the rename, so a second session's call could find no skills. Also flagged, and kept out of scope: a VM agent's `[ATTACHMENT:path]` marker is not resolved.
- Round 2 (13fe9c0): must-fix. The swap now renames the old folder aside and deletes it afterwards, which is right, but the retry test never retried.
- Round 3 (bc91abd): clean. The retry test fails when the retry is removed, and the old skills stay aside when they cannot be put back.

## Nits left

- No test for a cleanup `remove` that fails after the swap. The code swallows that error, and nothing would catch a regression.
- Two comments in `vm-workdir.ts` run past 80 columns.
- A `skills.old.<runId>` or `skills.<runId>` folder stays in `/workspace` if the Durable Object dies mid-swap. It is scratch and goes when the VM sleeps.
- The skills folder is missing for the time of one rename round trip during a swap. A fully atomic swap needs `RENAME_EXCHANGE` or a symlink flip, which departs from the task's design.

## Ideas beyond the scope

- Returning a VM file to the user: the VM prompt now tells the agent to write `[ATTACHMENT:<absolute path>]`, but `uploadOutputs` reads the library only, so a VM path comes back as an attachment failure. This was already true before W.2, and W.2 makes the model use the marker more. Needs its own task, or W.7.
- Egress audit gap: the VM keeps one outbound egress, set by the last run that called `setEgress`. Sessions of one agent share the VM, so a credential added outside the VM is audited under that run and not under the run that made the request.
- Old per-session snapshots under `vm-snapshots/` are not migrated. Agent VMs start empty.
- Two sessions of one agent share `/workspace/home`, and the last write wins.

## Steps for Dom

- Add the production R2 lifecycle rule on `vm-snapshots/` before VM agents run there.
- Staging check (controller): a VM agent writes `/workspace/home/note.txt` in chat A, waits over 4 minutes until the VM sleeps and a snapshot object shows in R2, then chat B reads the file. `/tmp/x` from chat A is gone in chat B.
