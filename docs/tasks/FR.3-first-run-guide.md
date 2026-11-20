---
id: FR.3
title: "First run: add your AI account on the home page"
milestone: FR
size: S
status: done
depends_on: [RH.3]
branch: task/FR.3-first-run-guide
lane: web-home
executor: claude
---

From `docs/v4/build-plan.md`, milestone FR. A new workspace needs a model key before anything works, and today that is a link into Settings.

## Scope

- On an empty home, show two steps inline: add your AI account (the model key form from `components/model-providers/` embedded, with a one-line explanation of what it is and what it costs), then pick a template or describe an agent.
- The description a person typed survives adding the key.
- Remove the two setup rows from the rail sources once this ships (`rail-pane/setup-pane.tsx`).
- Starter credit is out of scope. It is a billing decision for Dom.

## Check

- Browser on a fresh workspace: add a key, create an agent from the home page without opening Settings.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/FR.3-first-run-guide (v4 controller session).
- 2026-11-20: merged as 25330de3, review clean after 0 fix rounds. Browser proof passed at both sizes: docs/reviews/tasks/FR.3/browser.md. check, test and build passed on main. It removed the unused RailView.setup from packages/db/src/shared.ts, a contract file.
