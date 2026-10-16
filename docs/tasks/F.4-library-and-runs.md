---
id: F.4
title: Attach from the library, save outputs to the library
milestone: F
size: S
status: done
depends_on: [F.1, F.3, M7.2]
branch: task/F.4-library-and-runs
---

From the just-bash spike (`harbourmaster-wt/tmp/spike-just-bash/REPORT.md`). Draft, not approved.

## Scope

Library files and run files stay separate stores. Linking them copies bytes, so a run's inputs never change under it.

Attach: the composer gets "From library", which picks a path. The service copies the object into a new `files` row (`source` gets a `library` value) and the run lists its id in `input_file_ids` as today. The daemon needs no change.

Save: an output file chip gets "Save to library", which asks for a path (default `/outputs/<agent>/<file name>`) and copies the bytes into the library with a `library.write` event. Agents can already save with the `bash` tool (F.2), so this is for people.

## Check

Service tests: attaching a library file creates a `files` row the run can download and a later library edit does not change it; saving an output writes the library path and an event; a user of workspace B cannot attach A's library path. In local dev: attach a library note to a chat message and the agent reads it from `inbox/`; save the reply's chip and it shows up on the library page.

## Log
- 2026-10-16: drafted from the just-bash spike.
- 2026-10-16: added from the just-bash spike (docs/reviews/spike-just-bash.md). Dom accepted the defaults: library in Harbourmaster on R2, agents write anywhere, agents may edit their own skills, paid Workers plan, 10 MB per file and 1 GB per workspace, just-bash beta with network, Python and JS off.
- 2026-10-16: dispatched on task/F.4-library-and-runs.
- 2026-10-16: review clean after 1 fix round at 03332e4 (docs/reviews/tasks/F.4.md). Merged. Live: attach from library and save output to library both worked.
