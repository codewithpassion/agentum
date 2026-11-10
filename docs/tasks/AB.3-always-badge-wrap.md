---
id: AB.3
title: The "Always" badge in ask overrides fits on one line
milestone: AB
size: S
status: done
depends_on: [AB.2]
branch: task/AB.3-always-badge-wrap
lane: web
executor: claude
---

Found on staging on 10 Nov 2026 while checking AB.1 and AB.2. On an agent page, under Advanced, "Ask overrides", the row "Emails someone outside the workspace: always asks" shows its badge as "Alwa / ys" on two lines. Screenshot: `/home/roboto/devel/harbourmaster-wt/tmp/verify2/expanded.png`. Start at `apps/web/src/components/agent/profile/ask-before-card.tsx` and whatever renders the overrides.

## Scope

- The badge never wraps (for example `shrink-0` and `whitespace-nowrap` on the badge, with the row text wrapping instead). Don't edit `components/ui/`.

## Check

- A component test or a local browser screenshot at a narrow and a wide width shows the badge on one line.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-10: added from the staging check of AB.1 and AB.2, and dispatched to a Sonnet implementer on task/AB.3-always-badge-wrap.
- 2026-11-10: review clean after 1 fix round. Merged as c904106b; check, test and build green. Staging look pending, controller.
