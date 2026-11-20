# RH.8 review: One avatar for an agent everywhere

## Verdicts

- Code review, round 1 (fcb4d1eb): one must-fix, six nits. The must-fix was the Map's agent node, which still draws initials on a tone colour. The Map is not among the surfaces the task names, and the reviewer said the verdict is clean if it counts as out of scope. It is recorded as a follow-up below. No fix round followed, so the review is clean after 0 fix rounds. Two nits were fixed in 25c97eb5.
- Browser proof, round 1 (25c97eb5): pass at 1280x800 and 390x844. A fresh verifier ran it. Report and screenshots in `docs/reviews/tasks/RH.8/browser.md`.

The receipt was seen only on a failed dry run, because the Cloud runtime cannot start locally. The agent step tile on it matched. The reply and tool steps use the same tile component. A Needs you question card was not exercised, only an approval.

## What changed

`AgentRecord`, the profile header, `TaskView.agent` and `RailCard` carry the stored avatar. `AgentTile` (`shell/agent-tile.tsx`) draws it on the Roster card, the room header, the draft card (default avatar for its name), the Needs you drawer row, the Desk cards, the receipt, the team list and room member tiles. `agentInitials` and `agentTileColour` are deleted. People on Desk cards and in room posts get `defaultAgentAvatar(name)`, one letter instead of two initials. The 30px tiles are now 32px.

## Nits left

- `desk-board.tsx` has no test for `identityOf` (person, known agent, unknown agent).
- An unknown agent on the Desk shows a coloured "A" (`defaultAgentAvatar("An agent")`), while the team list and the column default show a slate "?".
- Room header and draft card tiles went from `font-bold` to `font-semibold`.
- browser.md was run on the fake runtime, and its console section lists errors from a dev-server restart and the failed Cloud start, not from this change.

## Ideas beyond scope

- Follow-up task: the Map's agent node (`map/map-logic.ts` `initialsOf`, `map-nodes.tsx`) and the node inspector tile (`map-inspector.tsx`) still draw initials on a tone colour. Carry `avatar` on agent map nodes and draw `AgentTile`. Then `initialsOf` and `toneOf` can go for agent nodes.

## Steps for Dom

None.
