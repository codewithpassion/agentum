---
id: RH.3
title: "Home page: the agent card wall"
milestone: RH
size: M
status: done
depends_on: [RH.1, NV.1]
branch: task/RH.3-roster-home
lane: web-home
executor: claude
---

From `docs/v4/build-plan.md`, milestone RH. Home becomes a wall of agent cards. Mockup: Proposal A in `docs/research/ui-reimagine-2026-11/report.html`.

## Scope

- New route `apps/web/src/routes/_app/home.tsx` and components in `components/roster/`. The signed-in landing redirects to it instead of `/desk`.
- A card shows avatar, name, job line, state dot, status line, owner and cost this week. Cards with `needs_you` come first, then `stopped`, `working`, `idle`.
- A strip at the top lists the open Needs you items from `desk.railSources` as chips. A chip opens the existing item pane at `/desk?item=<id>`.
- Two dashed cards: "New agent" to `/agents/new`, and "Start from a template" (links to `/agents/new` until FR.4).
- A card click opens `/agents/$agentId`. Refresh on the same poll interval the rail uses. On a phone the wall is one column.
- Add the page to `find-registry.ts`.

## Check

- Component tests for sort order and the empty state.
- Browser: three agents in different states sort correctly, a chip opens its item, a card opens the agent.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/RH.3-roster-home (v4 controller session).
- 2026-11-20: merged as 81af5eda, review clean after 0 fix rounds. Browser proof passed at both sizes: docs/reviews/tasks/RH.3/browser.md. check, test and build passed on main. The state sort was proved on a mocked roster.list; re-check it on real data in the RH e2e task.
