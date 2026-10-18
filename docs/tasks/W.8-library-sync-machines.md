---
id: W.8
title: Library folder synced onto machines
milestone: W
size: M
status: todo
depends_on: [W.6, W.7]
branch: task/W.8-library-sync-machines
---

Asked for by Dom on 18 Oct 2026, from the report (section E). Machines keep a per-agent work dir but reach the library only through MCP tools. This task reuses the sync core from W.7 (`packages/library-sync`). It needs only that module, not the VM wiring, so it can start once the module has merged.

## Scope

- The daemon copies `agents/<slug>/` plus the paths named in agent config into the work dir under `library/`, with the manifest beside it, using the W.7 module with a local port over the machine's disk. Same rules as W.7: skip files over 10 MB, never overwrite unsynced local edits on sync-in, ifEtag write-back, `<path>.conflict-<runId>` copies, local delete only on a matching etag, `stat` before a new file.
- Write back at run end and at checkpoints, using the run token from the claim (`machine-claim.ts:227`), since the daemon's own principal cannot write. If no bearer route lets a run token read and write library files with `ifEtag`, add the smallest one (thin call to the library service, as in the other bearer routes) and document it in `packages/services/README.md`.
- The claim carries the sync paths and the list of pending conflict copies. The daemon's prompt (W.6) lists them. The `library.conflict` event from W.7 is written for machine runs too.
- `prepareWorkDir` keeps `library/` and its manifest across runs, like the rest of home.

## Check

- Daemon tests with a fake remote: sync-in, sync-out, a conflict copy, a local delete with a changed etag, an unsynced local edit surviving sync-in, and write-back using the run token. A route test if a new route is added: a run token writes with `ifEtag`, a stale etag is refused with `conflict`, and a user without access is refused.
- Live on staging (controller): a machine agent edits a file under `agents/<slug>/` and the change reaches the library. A person edit during the run produces a conflict copy.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-18: added at Dom's request.
