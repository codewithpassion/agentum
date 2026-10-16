---
id: F.3
title: Library browse page
milestone: F
size: S
status: todo
depends_on: [F.1]
branch: null
---

From the just-bash spike (`harbourmaster-wt/tmp/spike-just-bash/REPORT.md`). Draft, not approved.

## Scope

A `library` tRPC router (`list`, `read`, `write`, `remove`, `mkdir`) on `workspaceProcedure`, each one service call. A `/library` route: a folder list with breadcrumbs, name, size and modified time, a text view for files up to 1 MB, a download link for the rest, upload into the current folder, new folder, delete with a confirm. Text files get a plain textarea editor that saves with the etag it loaded, and a `conflict` shows "changed since you opened it". No rich editor, no search.

## Check

A router test: a signed-in user lists and reads their workspace's library and gets 401 without a session. In local dev: upload a file, open it, edit and save it, see the change through the F.2 `bash` tool (`cat`), delete it. `bun run build` and the `drizzle` grep on `dist/client` pass.

## Log
- 2026-10-16: drafted from the just-bash spike.
- 2026-10-16: added from the just-bash spike (docs/reviews/spike-just-bash.md). Dom accepted the defaults: library in Harbourmaster on R2, agents write anywhere, agents may edit their own skills, paid Workers plan, 10 MB per file and 1 GB per workspace, just-bash beta with network, Python and JS off.
