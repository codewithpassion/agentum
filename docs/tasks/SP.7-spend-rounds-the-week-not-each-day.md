---
id: SP.7
title: "Spend rounds the week, not each day"
milestone: SP
size: S
status: done
depends_on: [SP.5]
branch: task/SP.7-spend-rounds-the-week-not-each-day
lane: services-spend
executor: claude
---

From the spend walkthrough (`docs/reviews/SP-e2e.md`).

`rollupSpend` rounds cents once per agent and day. Three days of $0.004 each show as $0 each, and the page reads $2.05 for last week where the data says $2.062. DR.7 measured a Haiku dream at $0.0006 to $0.0018. One a night adds under a cent to a day, so an agent that only dreams shows $0, and the cap check cannot see that spend either.

## Scope

sum the unrounded USD for a week and round once, for the page cells, the agent header, the card line and `weekToDate`. `SpendRow` keeps `cents` per day for the bars and gains a field with the unrounded amount, for example `micros`, millionths of a dollar as an integer. The sums use that field. The cap check and the page must give the same figure.

## Check

a rollup test with three days of $0.004 gives a week of $0.01 where today's code gives $0. A cap test where only small dreams cross the cap pauses the agent. The walkthrough's last week for Fake echo reads $2.06.

## Log
- 2026-11-21: added from the spend walkthrough.
- 2026-11-21: dispatched.
- 2026-11-21: ready at 6c8077d5 after one fix round, review clean. Queued for merge.
- 2026-11-21: merge conflict with SP.8 in spend-pause-card.tsx. Sent back to merge main.
- 2026-11-21: merged main with SP.8, resolution reviewed clean. Ready at 8253a2b8. Queued for merge.
- 2026-11-21: second merge conflict, with SP.10 and SP.9 in spend-logic and spend-caps tests. Sent back to merge origin/main.
- 2026-11-21: merged origin/main (SP.9, SP.10), resolution reviewed clean. Ready at a3f02420.
- 2026-11-21: merged 76ad9723, merge check passed. Done.
