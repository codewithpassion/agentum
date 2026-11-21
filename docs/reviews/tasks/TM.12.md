# TM.12 review

Round 0 (head acf4861): clean. Nothing must-fix. The browser proof passed at 1280x800 and 390x844, see `docs/reviews/tasks/TM.12/browser.md`.

The card recognises a proposal by the tool name `team_propose_change` plus a parsed proposal input (`proposalOf`), not by `isTeamProposal`, because an approval display carries no tool use id. The "Now" value is read with `agents.get` when the card mounts.

## Nits left

- `currentProposalValue` sends `contextBudget` through `default:`. A fifth proposal field would show the budget until a case is added.
- When `agents.get` fails, the "Now" row is simply absent, with no sign of why.
- The note field reads "Note for Reject (optional)" but Approve sends the note too. It copies the generic card's "Note for Deny".
- The component test covers only a successful `agents.get`.
- Phone buttons are 40px tall, under 44px. This is the shared approval card's size.

## Ideas beyond scope

- The room heading above a pending request reads "Writer Bo needs you" (`room-requests.tsx:123`), the target, not the lead who asks.
- Needs you and `/desk?item=<id>` still read "Writer Bo asks before team propose change" and "Writer Bo started this" (`rail/logic.ts`).
- After a decision the settled line says "Allowed once by ..." or "Denied by ...". For a proposal "Approved" and "Rejected" would match the buttons.
- `team-propose.ts` makes the server log "Slack request card failed: database is locked" while it holds the local database.

## Steps for Dom

None.
