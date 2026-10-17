# C.8 review notes

Execution environment for cloud agents. Branch task/C.8-cloud-exec-env.

## Verdicts

Round 1 at 7c5e6ea: must-fix. One item. The environment id was a constant, and Pi keys its per-file write queue on environment id plus path, so workspaces in one isolate shared a queue. A hung library call in one workspace could stall another workspace's edits.

Fix at 5cece44. `createLibraryEnv` takes a required `workspaceId` and builds the id from it.

Round 2 at 5cece44: clean.

## What was built

`createLibraryEnv` (`apps/web/src/server/library-env/`) is an `ExecutionEnv` over `LibraryOps`, the same library service with a principal bound that the library `bash` tool uses. Only `/library` and paths under it exist, and a relative path starts there. Reads open a snapshot, so a reader keeps working after its file is renamed. `PiRun` installs Pi's own `read`, `write` and `edit` (`libraryToolsExtension`, with a short prompt section) and builds the env on each use from the newest run's principal, stored under a `run` key. `read` is replay-safe, `write` and `edit` are not. `bash` is not installed. `exec`, `watch` and the temp file methods answer `shell_unavailable` or `not_supported`. `bindLibraryOps` is shared with the MCP ports. `libraryFsError` and `clamp` are now exported from `library-fs.ts`, and `LIBRARY_MOUNT` from `run.ts`.

Checks: unit tests run the reader conformance cases from pi-durable's `createEnvConformance`, Pi's tools through a real harness against the real library service, and `scripts/e2e/cloud.ts` has a new scenario (write, edit, read, then the platform's `bash cat` sees the edit). The round 1 reviewer also ran the full conformance suite: every case outside watch and exec passes. Live: with a dev server, `bun scripts/e2e/cloud.ts` passed all 9 scenarios, and `/library/e2e-env/notes.md` showed "gamma beta" in the browser after Pi's edit.

## Nits left

- `RUN_KEY` is written before `runCore().start()`. A second start of an older run moves it back to that run, and a run that joins a busy session takes over attribution of the earlier run's tool calls. Authz checks only the workspace, so only the run id on library events is affected. `SKILLS_KEY` has the same shape.
- A session already active before this deploy has no `RUN_KEY`, so its file tools fail with "No execution environment" until its next `startRun`.
- `joinPath` returns an absolute path. Node's returns `join(...parts)`, which stays relative. Pi only passes absolute paths.
- Abort is checked before the library call, not after it, in append, truncate, flush and the open methods.
- EEXIST, ENOTEMPTY, EFBIG and EAGAIN map to `invalid`. Node maps them to `unknown`.
- The conformance case "directory reader skips entries removed during enumeration" is skipped. A snapshot reader cannot hold it.
- `library-fs.test.ts` and the two new tests keep their own copy of the principal-binding literal and do not use `bindLibraryOps`.
- The e2e checks the edit through the platform's `bash cat`, and the `/library` page was checked by hand.

## Ideas beyond the scope

- Follow-up for the shell: a Sandbox-backed `ExecutionEnv.exec` (Cloudflare Sandbox or Containers) so Pi's `bash`, `git`, `node` and `python` work. This task backs files only.
- A just-bash backed `exec` over the same library mount would give Pi's `bash` tool without a container, but it duplicates the library `bash` tool the agent already has over MCP.
- Record `library.command` style audit events for Pi's file tool calls. Today they show only as `tool.call` and `tool.result` run events.

## Steps for Dom

- None needed for staging beyond the usual deploy. Local dev needs `PUBLIC_BASE_URL=http://localhost:<port>` in `apps/web/.env.local` for a cloud run.
- For a staging check: make a cloud agent, put a file in `/library`, ask the agent to edit it, then open it on `/library`.
