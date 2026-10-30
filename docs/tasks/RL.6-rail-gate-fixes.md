---
id: RL.6
title: "Rail gate fixes"
milestone: RL
size: M
status: in_progress
depends_on: [RL.1, RL.2, RL.3, RL.4, RL.5]
branch: task/RL.6-rail-gate-fixes
lane: services
executor: claude
---

From the milestone gate, `docs/reviews/RL-1.md`, and the first browser run on staging. The spec is `docs/ux-review/rail/spec.md`.

## Scope
- M1, M2 and M3 exactly as `docs/reviews/RL-1.md` describes them, with their checks. M1 includes the spec change to rule 2.
- `pane-logic.ts:62`: when `?item=` isn't in the current scope, say so instead of silently showing another item. If the item exists under Everyone, offer to switch. Never leave a URL that names one item with a different one on screen and its buttons live.
- `rail-pane.tsx:34`: `readScope` must survive blocked storage, as `use-rail.ts` does.
- `rail-pane.tsx:207`: the send failure banner names the mail that failed and clears when the next item opens.
- The Q&A count went with the old sidebar. Open questions need a count in the rail: a quiet `N open questions` row linking to `/qa` under the done count, shown only above zero.
- Problem wording. A bounced mail reads `Mail to <address> bounced`, using the address the card already has, and a failed run reads `<agent> stopped before finishing`. Not "<agent>'s work: mail bounced".
- `Open the log` and `Dismiss` look like the same kind of button.
- `desk.ts` comments that still say "sidebar badge".

## Check
- The checks M1, M2 and M3 list.
- Tests for the out-of-scope `?item=`, for `readScope` with storage that throws, and for the new problem wording.
- `bun run check && bun run test && bun run build` pass, and the `drizzle` grep of `apps/web/dist/client` finds nothing.

## Log
- 2026-10-31: created from the milestone gate. Dispatched.
