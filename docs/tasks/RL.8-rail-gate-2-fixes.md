---
id: RL.8
title: "Rail gate 2 fixes"
milestone: RL
size: S
status: done
depends_on: [RL.7]
branch: task/RL.8-rail-gate-2-fixes
lane: services
executor: claude
---

From the second milestone gate, `docs/reviews/RL-2.md`.

## Scope
- M4 and M5 exactly as `docs/reviews/RL-2.md` describes them. The pane must never tell a person an item is gone or under Everyone because its own data is older than the click.

## Check
- The checks `docs/reviews/RL-2.md` lists for M4 and M5.
- `bun run check && bun run test && bun run build` pass, and the `drizzle` grep of `apps/web/dist/client` finds nothing.

## Log
- 2026-10-31: created from gate round 2. Dispatched.
- 2026-10-31: merged, review clean after 1 fix round. Milestone closed after two gate rounds.
