---
id: RL.2
title: "Rail service, mail titles, longer mail approvals, owners, members and tRPC"
milestone: RL
size: L
status: done
depends_on: [RL.1]
branch: task/RL.2-rail-service
lane: services
executor: claude
---

Spec: `docs/ux-review/rail/spec.md`, the section "Service and API (RL.2)" and the Rules. The spec is part of this task and wins over anything else. The clickable design is `docs/ux-review/rail/design.html` (open it with Playwright or read the source, including `?who=dan` and `?scope=everyone`). Why: `docs/ux-review/review.md`.

## Scope
- `packages/services/src/rail.ts` and `packages/services/src/rail/logic.ts`, with `@repo/services/rail` in `exports`.
- Every helper the spec names, with table tests. Assignment, escalation at the 4 hour boundary, Mine with no owner, an owner who left the organisation, a failed member lookup, grouping, sort order, stuck runs and dismissal, hand-off labels, and setup steps all get service tests through `bun:sqlite`.
- `desk.get` mail titles, `requests.open` `ttlMs`, the mail outbound call, `agents.setOwners`, `rail.clearAttention`.
- The member-listing port and its Clerk implementation under `apps/web/src/server/`.
- tRPC `desk.rail`, `desk.clearAttention`, `members.list`, `agents.setOwners`, wired in `composeWith` and `Services`, with router tests.
- No UI in this task. `context.ts` doesn't change.

## Check
- A test proves no desk or rail card title contains "quoted JSON".
- A test proves a held mail approval expires after 3 days and a non-mail approval after 1 hour.
- Tests prove rule 3: another member can still answer a request that's assigned to someone else.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-30: created from Dom's request to design, spec and build the rail.
- 2026-10-30: dispatched.
- 2026-10-31: merged, review clean after 1 fix round.
