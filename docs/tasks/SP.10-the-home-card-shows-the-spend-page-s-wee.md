---
id: SP.10
title: "The Home card shows the Spend page's week"
milestone: SP
size: S
status: done
depends_on: [SP.5]
branch: task/SP.10-the-home-card-shows-the-spend-page-s-wee
lane: web-home
executor: claude
---

From the spend walkthrough (`docs/reviews/SP-e2e.md`).

Without a limit, an agent's Home card shows the roster's figure, `costThisWeekCents`. The roster adds up the last seven days of runs in sessions the viewer can see (`runFacts` in `roster.ts`), and the Spend page adds up the calendar week of every run in the workspace. With a limit set the card switches to the Spend page's figure (`withLimitWeekSpend`, SP.4). In the seeded data the runs sit in another user's private sessions, so Fake second's card read "$0 this week" next to "$0.55" on the Spend page. Two members with their own private threads would see the same split. The label says "this week" in both places.

## Scope

the Home card, and the Cost this week column of the agents table, read this week's cents from the same `spend.workspace` rows the page uses, for every agent, with or without a limit. The roster drops `costThisWeekCents` if nothing else reads it.

## Check

a component test where the roster says $0 and the spend rows say $0.55, and the card reads $0.55. A browser pass: seeded Fake second shows "$0.55 this week" on Home with no limit set, at both sizes.

## Log
- 2026-11-21: added from the spend walkthrough.
- 2026-11-21: dispatched.
- 2026-11-21: ready at e6df0220, review clean with no fix rounds, browser pass at both sizes. Queued for merge.
- 2026-11-21: merged cf769ca5, batch merge check with FX.3, SP.10 and SP.9 passed. Done.
