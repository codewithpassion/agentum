---
id: FR.4
title: "Templates gallery"
milestone: FR
size: S
status: todo
depends_on: [FR.1]
branch: null
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
