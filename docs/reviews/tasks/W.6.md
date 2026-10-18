# Review: W.6 Machine scratch folder and prompt

## Verdicts

- Round 1 (a65ba83): must-fix. The new files section dropped the old rule that attachments live inside the work dir, which the daemon still enforces (`outside_root`).
- Round 2 (187c3fc): clean. The append now ends with "A file can only be attached from inside <workDir>."

## Nits left

- The shared builder's home line says "Other sessions of yours may use it at the same time", but the daemon runs one run per agent at a time (`run-manager.ts`).
- The multi-user "keeps other files" part is shown only by which paths the `rm` names, and no test covers a failing `mkdir tmp` step.
- The two prompt tests in `executor.test.ts` repeat the code that pulls `append` out of the system prompt.

## Ideas beyond the scope

- Move the "attach only from inside home" rule into `workspaceInstructions` as an option if other local runtimes enforce a root too.

## Steps for Dom

None. The staging check (a file in the work dir survives two chats, a file in `tmp/` does not) is the controller's.
