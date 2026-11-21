---
id: TM.24
title: "A lead's proposal reads as a proposal everywhere it shows"
milestone: TM
size: S
status: done
depends_on: [TM.12]
branch: task/TM.24-a-lead-s-proposal-reads-as-a-proposal-ev
lane: web-room
executor: claude
---

From the TM.12 review (`docs/reviews/tasks/TM.12.md`, items left outside the card). TM.12 made the proposal card itself say what the lead proposes. Three other places still describe it as a plain tool approval on the target agent.

## Scope

- The room heading above a pending proposal names the lead who asks, not the target agent (`room-requests.tsx:123` reads "Writer Bo needs you").
- Needs you and `/desk?item=<id>` describe a `team_propose_change` request as a proposal from the lead, for example "Lead Ana proposes a change to Writer Bo", not "Writer Bo asks before team propose change" or "Writer Bo started this" (`rail/logic.ts`). Detect it the same way TM.12 does (tool name plus `proposalOf`).
- After a decision on a proposal, the settled line says "Approved by ..." or "Rejected by ...", matching the buttons. Other approvals keep "Allowed once" and "Denied".

## Check

- Unit tests for the rail wording and the settled line, for a proposal and for a plain approval.
- Browser at 1280x800 and 390x844: a pending proposal in the room, in Needs you and on the desk item, then the settled line after Approve.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-21: added by controller from the TM.12 review.
- 2026-11-21: dispatched.
- 2026-11-21: ready at 70bc5b0a, review clean, one reviewer nit fixed in a one-line commit, browser proof passed.
- 2026-11-21: merged da902e93, merge check passed. Done.
