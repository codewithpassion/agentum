# W.5 review: library homes for isolate and managed agents

## Verdicts

- Round 1 (a6f1cce): not clean. Two must-fix findings.
  - A relative `[ATTACHMENT:...]` marker was read from the library root, while the isolate's cwd is now `agents/<slug>`. Fixed: `uploadOutputs` takes the home and reads relative markers from it.
  - Managed Agents were told to attach files, but nothing reads markers for a managed run. Fixed: `workspaceInstructions` takes an optional `attachments: false`, and the managed system text uses it.
- Round 2 (1c3b26b, fix commit only): clean.

## What changed

- `@repo/services/library/home` holds `agentHomePath` and `ensureAgentHome` (stat, then mkdir when missing). Both runtimes use it.
- Isolate: `PiRun.startRun` makes `agents/<slug>` before the run, stores the slug, and passes `/library/agents/<slug>` as the `cwd` of `createLibraryEnv`. The files prompt in `library-tools.ts` comes from `workspaceInstructions`.
- Managed: `launch` makes the folder with a run principal, and `systemOf` adds the files section.
- `CloudStart.agent` now carries `slug`.
- The `filesExtension` prompt section is gone. Isolate sessions get the attachment line from `workspaceInstructions`. Linux VM sessions have no attachment line until W.2 gives the VM its own `workspaceInstructions`. Expect a merge conflict in `pi-run-files.ts` and `pi-run.ts` with W.2.

## Left alone

- A renamed agent (new slug) leaves its old `agents/<old-slug>/` folder behind. Nothing moves or removes it, as the task says.
- The system text is part of the managed fingerprint, so each managed agent re-registers once on deploy and open Managed sessions rotate once, losing their `/workspace` scratch. A slug change rotates the session too.

## Nits left

- The isolate prompt says relative paths start in home, but the library `bash` tool (MCP) still starts in `/library`.
- `ensureAgentHome` does stat then mkdir. Two first runs at the same moment could both mkdir (mkdir is idempotent). A file sitting at `agents/<slug>` would pass the stat.
- `pi-run-files.ts` keeps a private `LIBRARY_ROOT` that duplicates `LIBRARY_MOUNT`.
- No test covers the `PiRun` wiring (`startRun` ensures the home for the isolate and not the VM, `outputsOf` passes the home). `PiRun` is a Durable Object, so only the pieces are tested.
- `outputsOf` relies on `#vm` being restored before it runs.

## Ideas beyond the scope

- Per-agent write roots (`canWriteAt`) so the folder convention could be enforced.
- Resolve relative attachment markers for VM sessions against `/workspace/home` (W.2, W.4).

## Steps for Dom

- Staging check from the task: an isolate agent and a Managed Agent each write a note in chat A and read it in a new chat B.
