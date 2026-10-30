---
id: RL.7
title: "Rail acceptance fixes: readable names, what they wrote"
milestone: RL
size: S
status: done
depends_on: [RL.6]
branch: task/RL.7-rail-acceptance-fixes
lane: services
executor: claude
---

Found by the first acceptance run on staging (`docs/ux-review/tooling/rail-video.ts`). The spec is `docs/ux-review/rail/spec.md`.

## Scope
- Mail approval titles read `Reply to jane.doe@harcourt-logistics.example: Moving Thursday's review`, which wraps to three lines in the rail. `recipientWho` in `packages/services/src/rail/logic.ts`: when there's no display name, turn the address's local part into words. `jane.doe@...` gives `Jane Doe`, `tom.reid@...` gives `Tom Reid`, `accounts@...` gives `Accounts`, and `j_smith99@...` gives `J Smith`. Fall back to the full address when nothing usable is left. The pane's `Goes to` line keeps the real address.
- `They wrote` is empty when an agent's reply started a new mail thread, which happens whenever the agent replies to someone other than the mailbox it heard from, such as a forwarded message. In `packages/services/src/rail.ts`: when the thread has no inbound message, use the inbound message of the request's own run (`mail_messages` with `direction = 'in'` and the same `run_id`). `inboundAt` follows it, so `dueFrom` sees the original words.

## Check
- Table test for the name forms above.
- A service test: an approval on a new thread whose run started from an inbound mail shows that mail's snippet in `theyWrote`, and a due date in that mail reaches `dueAt`.
- `bun run check && bun run test && bun run build` pass, and the `drizzle` grep of `apps/web/dist/client` finds nothing.

## Log
- 2026-10-31: created from the acceptance run. Dispatched.
- 2026-10-31: merged, review clean.
