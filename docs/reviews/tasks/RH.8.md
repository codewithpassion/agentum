# RH.8 review: One avatar for an agent everywhere

## Verdicts

- Code review, round 1 (fcb4d1eb): one must-fix, six nits. The must-fix was the Map's agent node, which still drew initials on a tone colour. The controller ruled the Map in scope.
- Code review, round 2, fix commit b6cddf67 (the Map draws the stored avatar): clean, 0 must-fix, 5 nits. A fresh reviewer also grepped for left-over initials and tone code on agents and found none. The review is clean after 1 fix round.
- Browser proof, round 1 (25c97eb5): pass at 1280x800 and 390x844. A fresh verifier ran it.
- Browser proof, round 2 (b6cddf67): pass at both sizes for the Map (canvas nodes and inspector) and the Needs you question card. A fresh verifier ran it. Report and screenshots in `docs/reviews/tasks/RH.8/browser.md` (round 1 desktop-1..6 and phone-1..6, round 2 desktop-7..13 and phone-7..13).

Caveats from the browser proof: the receipt was seen only on a failed dry run, because the Cloud runtime cannot start locally, and the tile on it matched. The question card was opened and shown but not answered. Round 2 saw one untraced `400` during sign-in, before any page under test loaded, and no failed request after.

## What changed

`AgentRecord`, the profile header, `TaskView.agent` and `RailCard` carry the stored avatar. `AgentTile` (`shell/agent-tile.tsx`) draws it on the Roster card, the room header, the draft card (default avatar for its name), the Needs you drawer row, the Desk cards, the receipt, the team list and room member tiles. `agentInitials` and `agentTileColour` are deleted. Agent nodes on the Map and the Map inspector's tile draw it too (`MapNode.avatar`, `initialsOf` deleted). People on Desk cards and in room posts get `defaultAgentAvatar(name)`, one letter instead of two initials. The 30px tiles are now 32px.

## Nits left

- `desk-board.tsx` has no test for `identityOf` (person, known agent, unknown agent).
- On the Map a non-agent node's inspector tile now shows one letter instead of two initials, and the agent node tile is 32px next to 30px trigger and output tiles.
- `MapNode.avatar` is optional on every node kind, so the client keeps an `avatarOfNode` fallback.
- An unknown agent on the Desk shows a coloured "A" (`defaultAgentAvatar("An agent")`), while the team list and the column default show a slate "?".
- Room header and draft card tiles went from `font-bold` to `font-semibold`.
- browser.md was run on the fake runtime, and its console section lists errors from a dev-server restart and the failed Cloud start, not from this change.

## Ideas beyond scope

- None.

## Steps for Dom

None.
