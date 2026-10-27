# B.9 review: phase 2 UI

Branch `task/B.9-phase2-ui`. Task file: `docs/tasks/B.9-phase2-ui.md`.

## Verdicts

| Round | Commits | Verdict |
|---|---|---|
| 1 | v3/artifacts..5728cf2 | clean (10 nits, no must-fix) |

## What shipped

- Share dialog: data choice (Snapshot only preselected, Live using my connections for the owner only), tool checkboxes with none ticked, the PRD warning with the expiry beside it, "Live as <owner>" badge and tool list in the link list, Copy hidden for token-less urls. Argument-limit rows (`<tool>#<json>`) are filtered from every tool list.
- Grant approval card in Needs you for `artifact_promote` approvals: lists tools, hosts and secrets, Approve or Reject decide every grant (limit rows included) through `decideGrant`.
- Viewer: Proposed badge and picker labels, Promote for managers ("Waiting for approval" on CONFLICT), pin to sidebar and desk in the More menu, "Hand to agent..." dialog.
- Sidebar "Pinned" group and desk tiles.
- Router: `artifacts.grants` and `artifacts.pins` queries (the services existed; the router did not expose them). `PinnedArtifactView.kind` is now typed `ArtifactKind`.

## Nits left

- Every CONFLICT from `promote` reads as "Waiting for approval", including older-than-live and rejected versions.
- A person pressing Promote opens no Needs you request (only runs do), so for a version the agent never promoted the "Decide the grants in Needs you" link leads nowhere, and the viewer has no grant deciding UI.
- The approval card shows no line for a version that only changes argument limits; Approve skips grants already rejected by someone else and still reports success.
- `artifacts.grants` has no `.output()` schema and is open to anyone who can open the artifact; the share dialog calls it for non-managers too.
- Router tests cover the happy path only; no rendered test clicks the pin menu items (pure model tested).
- Sidebar pins refresh on a 10 s poll after a toggle in the viewer.
- Status badge casing differs between "Proposed" and other statuses; the hand-to list includes the maker agent.

## Ideas beyond the scope

- Grant list with Approve and Reject on the viewer page for a proposed version, which also fixes the dead end above.
- Thumbnails on pinned desk tiles (`pins.list` does not return them).

## Steps for Dom

Browser check of each item waits for B.6 (live links) and B.8; it belongs to B.10.
