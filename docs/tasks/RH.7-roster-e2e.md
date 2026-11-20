---
id: RH.7
title: "Roster walkthrough on local and staging"
milestone: RH
size: S
status: done
depends_on: [RH.2, RH.5, RH.6]
branch: task/RH.7-roster-e2e
lane: e2e
executor: claude
---

From `docs/v4/build-plan.md`, milestone RH. End-to-end check for RH against real services, not stubs.

## Scope

- Script the walkthrough with agent-browser on local dev login: land on home, create an agent by describing it, see its card, open it, send a message in Chat, answer a question from the Needs you drawer, see the card state change.
- Write findings to `docs/reviews/RH-e2e.md`. Fix what is small, list the rest as new task proposals for the controller.

## Check

- The walkthrough passes on local. The staging run is listed as a step for Dom if a deploy is needed.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/RH.7-roster-e2e (v4 controller session).
- 2026-11-20: merged as cf543d05, review clean after 0 fix rounds. Walkthrough passed at both sizes: docs/reviews/RH-e2e.md, docs/reviews/tasks/RH.7/browser.md. The card wall sort matches the rule on real data. check, test and build passed on main. Follow-ups RH.8 to RH.11. Dom: run it on staging with an Anthropic cloud agent after deploy.
