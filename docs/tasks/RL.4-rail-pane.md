---
id: RL.4
title: "The main pane: plain decisions, problems, setup and the board view"
milestone: RL
size: M
status: todo
depends_on: [RL.2]
branch: null
lane: web-pane
executor: claude
---

Spec: `docs/ux-review/rail/spec.md`, the section "The main pane (RL.4)" and the Rules. The spec is part of this task and wins over anything else. The clickable design is `docs/ux-review/rail/design.html` (open it with Playwright or read the source, including `?who=dan` and `?scope=everyone`). Why: `docs/ux-review/review.md`.

## Scope
- `routes/_app/desk.tsx`, `components/rail-pane/`, an export of `NeedsYouBody`, and the optional title on `RequestCard`.
- Mail decision, other kinds through the existing bodies, problem, setup, `How it got here`, moving to the next item, dispatching `RAIL_REFRESH_EVENT`.
- `?view=board` keeps today's desk working.
- Don't edit `_app.tsx` or `components/shell/`, which RL.3 owns.

## Check
- Component or logic tests: which view each kind gets, next-item selection, expiry shown only under 4 hours, and Send reply calling `requests.answer` with allow once.
- Browser check on local dev at 1440x900 and 390x844: open each kind that can be seeded with the dev fake runtime, and answer an approval. No `Use mail_send` heading and no monospace reply appear.
- After `bun run build`, grep `apps/web/dist/client` for `drizzle` finds nothing.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-30: created from Dom's request to design, spec and build the rail.
