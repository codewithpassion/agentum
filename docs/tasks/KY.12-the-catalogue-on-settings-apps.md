---
id: KY.12
title: "The catalogue on Settings, Apps"
milestone: KY
size: S
status: todo
depends_on: [KY.11]
branch: null
lane: web-settings
executor: claude
---

From the KY walkthrough (`docs/reviews/KY-e2e.md`).

Settings, Apps adds a connector only by URL. The catalogue is only on an agent's Keys tab, so an admin cannot add an app to the workspace without picking an agent. The KY milestone overview says "a small catalogue creates a connector from a name"; KY.4 built `catalog.add` and KY.5 put the picker on the Keys tab only.

## Decision

Decision (controller, 20 Nov 2026): add the catalogue picker to Settings, Apps, as the KY overview promises, through a component shared with the Keys tab.

## Check

Browser as admin: add Linear from Settings, Apps, then see it in the Keys tab's "Already in this workspace" group.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the KY walkthrough.
