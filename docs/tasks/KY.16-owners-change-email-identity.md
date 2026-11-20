---
id: KY.16
title: "Only owners and admins change an agent's email identity"
milestone: KY
size: S
status: todo
depends_on: []
branch: null
lane: services-mail
executor: claude
---

From the KY gate review, round 2 (`docs/reviews/KY-2.md`). This was KY's second and last gate round, so KY closes when this task merges.

## Decision

Controller decision (Dom's "don't wait for me", 20 Nov 2026): the email address and mailbox are keys, as KY.1 and the v4 Vocabulary say, so only the agent's owners and admins change them.

- `agents.reserveAddress`, `mail.provision` and `mail.disable` call `requireAgentOwnerOrAdmin` for the agent. Use the same admin test as KY.10 (an org admin on a session, or an admin key).
- The admin MCP `reserve_agent_address` tool and any other caller follow the same rule through the service. The system principal stays allowed, because the tick runs `mail.provisionPending` with it.
- The Keys tab's "Its own identity" section hides or disables the Email provision button for everyone else. Show a note like the Slack one: "Only the agent's owners and admins can set up its email." Apply the same gating anywhere else the app offers address reservation or mail enable and disable for an agent.

## Check

- Service tests for owner, admin, admin key and plain member on reserve address, provision and disable. A refused call leaves `agents.email_local` and the `agent_mailboxes` row unchanged, and calls no routing rule.
- Browser as a plain member on another person's agent: no working email controls, and the note shows. As the owner, provisioning works. Check both sizes.
- `bun run check && bun run test && bun run build` pass.


## Log
- 2026-11-20: added from the KY gate review, round 2.
