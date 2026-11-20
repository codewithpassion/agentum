---
id: ME.8
title: "Held notes in Needs you, learned count on the card"
milestone: ME
size: S
status: done
depends_on: [ME.1, RH.2]
branch: task/ME.8-memory-needs-you-and-count
lane: services-rail
executor: codex
---

From `docs/v4/build-plan.md`, milestone ME. Held notes must reach the person, and the card shows how much the agent learned.

## Scope

- Add held `memory_changes` to `desk.railSources` as kind `memory_note`, addressed to the agent's owner with the backup rule.
- `roster.list` fills `learnedCount` with applied changes from the last seven days.

## Check

- Tests in `rail.test.ts` and the roster service tests.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/ME.8-memory-needs-you-and-count (v4 controller session).
- 2026-11-20: merged as e7b4bb48, review clean after 1 fix round. check and build passed on main; tests passed except the two known flakes in FX.1.
