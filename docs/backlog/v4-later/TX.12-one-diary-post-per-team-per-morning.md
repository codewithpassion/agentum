---
id: TX.12
title: "One diary post per team per morning"
milestone: TX
size: S
status: todo
depends_on: []
branch: null
lane: services-dream
executor: claude
---

From the team extras walkthrough (`docs/reviews/TX-e2e.md`).

Finding. Every team dream posts its own diary at the next 08:00. Four manual dreams on one day gave four diary posts in the Team diary topic and four messages in the Slack channel at once. Dreams run once a night in production, so this shows only after "Dream now" repeats. If a UI button arrives (TX.10), it would show up often.

Scope. At the 08:00 slot post only the newest dream's diary for the team, or join the day's diaries into one post.

Check. A tick test with two finished dreams for one team and one slot: one post.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-21: added by controller from the TX walkthrough.
- 2026-11-21: controller decision: at the 08:00 slot post only the newest dream's diary.
- 2026-11-21: deferred to the backlog on Dom's scope freeze (only must-fix bugs stay in v4).
