---
id: F.1
title: Workspace library service over R2 with a D1 path index
milestone: F
size: M
status: done
depends_on: [M7.1]
branch: task/F.1-library-service
---

From the just-bash spike (`harbourmaster-wt/tmp/spike-just-bash/REPORT.md`). Draft, not approved.

## Scope

`createLibraryService({ db, blobs, clock })` in `packages/services`. One library per workspace. Bytes go in the `FILES` bucket under `${workspaceId}/library/<path>`. A new `library_entries` table indexes them: workspace id, path, kind (file or dir), size, mtime, etag, updated by. Listing, `stat` and recursive walks read the table, so only file reads and writes touch R2.

Methods: `list(dir)`, `stat(path)`, `read(path)`, `write(path, bytes, { ifEtag? })`, `remove(path, { recursive })`, `move(from, to)`, `mkdir(path)`. Each takes the principal and calls `authorize()` first. A user or a run principal of the workspace may read and write the whole library. Per-agent write roots are an open question, so the root rule lives in one function that returns true for now.

Paths are normalized in one place: no `..` past the root, no control characters, at most 512 bytes, at most 20 segments. Files are capped at 10 MB and the library at 1 GB per workspace. `write` with `ifEtag` passes `onlyIf: { etagMatches }` to R2 and returns `conflict` on a mismatch.

Writes and deletes append `library.write` and `library.delete` events (path, size, actor), added to `EVENT_TYPES` in `packages/db/src/shared.ts`. Row and event land through `atomic`.

Also update the "Shared wiki and knowledge base" and "Skills bundles per agent" rows of the Deferred table in `docs/architecture/index.html`: the workspace library and skills now live in Harbourmaster on R2 (docs/reviews/spike-just-bash.md), and The Brain stays the knowledge connector.

## Check

`library.test.ts` with the fake R2 from `files.test.ts` and `bun:sqlite`:

- a write then a list and a read return the file, and the index row matches the object size;
- `../` paths and paths with control characters are refused, and no R2 key outside `${workspaceId}/library/` is ever touched;
- a user of workspace A gets `not_found` for B's paths;
- two writes with the same stale `ifEtag` give one success and one `conflict`;
- a recursive remove deletes every row and object under the folder;
- each write and delete adds one event with the right actor.

`bun run check && bun run test` pass.

## Log
- 2026-10-16: drafted from the just-bash spike.
- 2026-10-16: added from the just-bash spike (docs/reviews/spike-just-bash.md). Dom accepted the defaults: library in Harbourmaster on R2, agents write anywhere, agents may edit their own skills, paid Workers plan, 10 MB per file and 1 GB per workspace, just-bash beta with network, Python and JS off.
- 2026-10-16: dispatched on task/F.1-library-service.
- 2026-10-16: review clean after 1 fix round at b1d2e74 (docs/reviews/tasks/F.1.md). Merged. Migration 0015.
