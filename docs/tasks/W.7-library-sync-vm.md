---
id: W.7
title: Library folder synced into the Linux VM, with the shared sync module
milestone: W
size: L
status: done
depends_on: [W.2, W.3, W.4]
branch: task/W.7-library-sync-vm
---

Asked for by Dom on 18 Oct 2026, from the report (section E). The VM cannot see the library, so an agent has to go through the platform MCP tools for every file. Dom chose a real folder in the VM that stays in step with the library. No R2 mount: `list` and `stat` read D1 only, so FUSE writes would skip `library.write` events and the compare-and-swap. The version already exists as `library_entries.etag`, and `write(ifEtag)` is a compare-and-swap through R2 (`library.ts:385-391`, `r2-library.ts:29-31`).

This task also builds the sync core that W.8 reuses. YAGNI: no separate task, since W.8 is the only other user.

## Scope

- New portable module `packages/library-sync` (own folder, types and tests, one `index.ts` barrel). It imports no app code and no VM code. Remote and local sides come in as ports: remote `list`, `stat`, `read`, `write(path, bytes, { ifEtag })`, `delete`; local `list`, `stat`, `read`, `write`, `remove`.
- Sync in copies only the agent's subtree `agents/<slug>/` plus paths named in agent config (an optional list of library paths in the agent's runtime config). It skips files over 10 MB. It writes a manifest `{ path, etag, sha256 }` beside the working copy, one manifest per working copy and not per run. It never overwrites a local file whose hash differs from the manifest.
- Sync out compares local files with the manifest and sends each change through `write(path, bytes, { ifEtag })`. On conflict it saves the local bytes as `<path>.conflict-<runId>` in the library and keeps the remote file. No merge, no last-write-wins. A local delete runs only if `stat` shows the etag still matches the manifest. A new local file runs `stat` first, and an existing remote file becomes a conflict copy. A rename counts as a delete plus a create.
- A `library.conflict` event goes into `EVENT_TYPES` with the path, the conflict copy path and the run id. The next run's prompt lists pending `.conflict-*` files under the agent's subtree (an optional `conflicts` input on `workspaceInstructions` from W.1).
- VM wiring in `PiRun`: the working copy lives at `/workspace/library`, outside home, so it is not snapshotted. `PiRun` syncs in at run start, and syncs out at run end and at each checkpoint from W.3. The remote port is the library service with the run's principal. The VM prompt names `/workspace/library` as a synced copy and says the rest of the library is reached with the library tools.
- Add the required wrangler/binding changes in all three places only if a new binding is needed. None is expected.

## Check

- Module tests with in-memory ports: first sync-in, a clean sync-out, a conflict (conflict copy saved and remote kept), a local delete with a matching and a changed etag, a new local file over an existing remote file, a rename, a file over 10 MB skipped, and sync-in leaving an unsynced local edit alone.
- `pi-run` tests with the fake VM: sync in at start, sync out at run end and at a checkpoint, a `library.conflict` event, and the next prompt listing the conflict copy.
- Live on staging (controller): a VM agent edits a file under `agents/<slug>/`, the change shows in the library page with a `library.write` event after the run. A person edits the same file mid-run, and the run leaves a `.conflict-<runId>` copy while the person's version stays.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-18: added at Dom's request.
- 2026-10-18: dispatched.
- 2026-10-18: review clean after 3 fix rounds at a5bc2c4 (docs/reviews/tasks/W.7.md); third round approved by the controller (lease lock in VmSession storage). Merged. Staging check pending.
- 2026-10-18: staging check passed (library folder in VM, writes on Library page, conflict copy plus library.conflict event, next prompt lists it). Two chats of one agent run one after the other (one running run per agent, runs.ts:644), so the lease was not contended live. Found separately: a run can hang at run.started when the browser leaves the chat page right after Send (3 cases, until lease expiry).
