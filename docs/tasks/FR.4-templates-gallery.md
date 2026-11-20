---
id: FR.4
title: "Templates gallery"
milestone: FR
size: S
status: done
depends_on: [FR.1]
branch: task/FR.4-templates-gallery
lane: web-builder
executor: claude
---

From `docs/v4/build-plan.md`, milestone FR. Show the templates where a person creates an agent.

## Scope

- A gallery on `/agents/new` above the describe box, in `components/agent/builder/`: one card per template with name and one line. A click loads the draft into the existing review screen.
- The home page's "Start from a template" card links here. Team starters appear in the New team dialog when FR.2 has shipped.

## Check

- Component test for the gallery. Browser: create an agent from a template.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/FR.4-templates-gallery (v4 controller session).
- 2026-11-20: merged as 14a38701, review clean after 1 fix round (plus a clean review of the no-key Create fix). Browser proof passed at both sizes: docs/reviews/tasks/FR.4/browser.md. check, test and build passed on main. The home card already links to /agents/new; team starters wait for FR.2.
