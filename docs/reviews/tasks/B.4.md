# B.4 review: grants, propose and promote, pins and hand-to

Branch `task/B.4-grants-promote-pins`. Task file: `docs/tasks/B.4-grants-promote-pins.md` ("Moved up" section wins).

## Verdicts

| Round | Commits | Verdict |
|---|---|---|
| 1 | 7dab5b6..5eb67a1 | must-fix: dropping an approved argument limit widened a grant; a card answer was never applied to the grants; the promote card made the run `waiting` and resumed the runtime on an id it never issued |
| 2 | to a2549ad | must-fix: the card answer applied only on the next `promote`, which nothing prompts |
| 3 | to 35a430f | must-fix: a stale card answer rolled the live app back |
| 4 | to 82d137d | must-fix: `promote` itself lacked the newer-than-live check |
| 5 | 82d137d..3e6dc30 | clean |

The integration of A.2's create and update (after merging `v3/artifacts`) came after round 5 and is covered by `app-grants.test.ts` and the last review round noted in the commit log.

## What shipped

- `packages/services/src/artifacts/manifest.ts`: parses and validates `harbourmaster.json` (tools with argument limits, hosts, vault secret names) from a version's file list and text.
- `grants.ts`: `recordVersionGrants`, `checkManifest`, `decideGrant`, `promote`, `handTo`, `list`, and a listener that applies the owner's answer on the Needs you card.
- `pins.ts`: pin, unpin, list for `sidebar` and `desk`.
- `packages/db/src/artifact-grants.ts`: the query functions, with claim statements (`UPDATE ... RETURNING`) as arbiters so events are written once.
- Router: promote, decideGrant, pin, unpin, handTo. `compose.ts` builds `artifactGrants` and `artifactPins`.
- A.2's create and update: `app` kind accepted, an agent's app version starts `proposed` with no live version, grants are checked before the write and recorded after it.
- Promote approvals are exempt from the run-wait and resume paths like mail approvals (`isDetachedApproval`, `notDetachedApproval` in `mail/approval.ts`).

## Nits left

- Going live is a claim on the version plus a pointer update, not one atomic write (`atomic` returns nothing, so it cannot arbitrate a race). A crash between them is finished by the next `promote` of the version.
- Rejecting a grant is a claim plus a separate `rejectVersionStatement`. A crash between leaves a `proposed` version with a rejected grant, which `promote` still refuses.
- `promote` does not check that grants were ever recorded; an app version with no rows promotes as if it declared nothing (downstream readers then see no approved rows).
- `recordVersionGrants` checks neither the artifact kind nor the version status.
- A newer-than-current check runs after the Needs you card opens, so a run promoting an older version still opens a card.
- The recovery branch of `promote` can write a second `artifact.promoted` in a narrow race.
- Pin positions are read then inserted, so two pins at once can share a position.
- Limits are stored as extra tool rows `<tool>#<json>`, and any change to a limit (narrowing too) asks a person again.

## Ideas beyond the scope

- Bridge the card answer for admins: the card follows the agent session's visibility, so only the owner's answer counts. An admin decides on the artifact page.
- `pins.list` could return thumbnails for tiles.

## Steps for Dom

None. B.8 must replace the stub tool catalog in `compose.ts` (`tools: { lookup: () => null }`) with the connector and platform catalog, build `createArtifactsService` with `grants: artifactGrants`, and B.9 must filter `<tool>#...` rows out of tool lists.
