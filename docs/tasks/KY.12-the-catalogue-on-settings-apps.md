---
id: KY.12
title: "The catalogue on Settings, Apps"
milestone: KY
size: S
status: in_progress
depends_on: [KY.11]
branch: task/KY.12-the-catalogue-on-settings-apps
lane: web-settings
executor: claude
---

From the KY walkthrough (`docs/reviews/KY-e2e.md`).

Settings, Apps adds a connector only by URL. The catalogue is only on an agent's Keys tab, so an admin cannot add an app to the workspace without picking an agent. The KY milestone overview says "a small catalogue creates a connector from a name"; KY.4 built `catalog.add` and KY.5 put the picker on the Keys tab only.

## Decision

Decision (controller, 20 Nov 2026): add the catalogue picker to Settings, Apps, as the KY overview promises, through a component shared with the Keys tab.

## Scope

- Settings, Apps gets the same catalogue picker as the Keys tab, through one shared component. It uses `catalog.add` and is for admins only.
- An app added there shows on every agent's Keys tab under "Already in this workspace".

## Check

Browser as admin: add Linear from Settings, Apps, then see it in the Keys tab's "Already in this workspace" group.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the KY walkthrough.
- 2026-11-20: dispatched on task/KY.12-the-catalogue-on-settings-apps (v4 controller session).
