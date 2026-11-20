---
id: TM.12
title: "The lead's proposal card says what it proposes"
milestone: TM
size: S
status: in_progress
depends_on: []
branch: task/TM.12-the-lead-s-proposal-card-says-what-it-pr
lane: web-requests
executor: claude
---

From the teams walkthrough (`docs/reviews/TM-e2e.md`).

Finding. A lead's proposal shows as the generic permission card, "Writer Bo asks before team propose change". Writer Bo is the target, not the asker. The buttons are Allow once, Always allow and Deny, and "Always allow" says it saves a rule, which makes no sense for a settings change. The field, the new value, the reason and the lead's name are only in a collapsed raw JSON "Input". The server already refuses "Always allow" for a proposal (`requests.ts`, "Allow it once instead"), so the button is offered and then fails. The verifier saw the card in Needs you and on `/desk?item=<id>` but not in the room. The room (`room-requests.tsx`) does list pending requests of the topic's sessions, and `team-propose.ts` attaches the card to the lead's newest room run in any topic, so the card probably sat in another topic. Not re-checked; look in the run's own topic first.

Scope. In `components/requests/request-card.tsx`, recognise a team proposal (`isTeamProposal` in `packages/services/src/teams/proposal.ts`) and render "Lead Ann proposes a change to Writer Bo", the field, the old and new value and the reason, with Approve and Reject and no "Always allow" button (a UI change only, the server already refuses it).

Check. Component test for the proposal card. Browser: the lead proposes, the owner reads and approves from the room.

## Log
- 2026-11-21: added by controller.
- 2026-11-21: dispatched.
