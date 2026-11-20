---
id: SL.1
title: "Slack link contract: one channel per team room"
milestone: SL
size: S
status: todo
depends_on: [TM.1]
branch: null
lane: contract
executor: claude
---

From `docs/v4/build-plan.md`, milestone SL. Contract task for SL. It alone changes `packages/db/src/schema`, generates migrations, edits `packages/db/src/shared.ts`, wires the new service in `apps/web/src/server/compose.ts` and mounts the new tRPC router in `apps/web/src/server/trpc/router.ts`. Every procedure exists after this task with its final input and output types and a stub body, so the service, MCP and web tasks of SL run in parallel against it. Dom's decisions of 19 Nov: one Slack app per agent stays, and one Slack channel maps to exactly one team room.

## Scope

- Table `team_slack_links`: team_id (unique), slack_team_id, channel_id (unique per slack_team_id), linked_by, created_at.
- Table `slack_room_messages`: slack_team_id, channel_id, ts (unique together), thread_ts, post_id, direction (`in`, `out`).
- `teams` service gains `slack.link`, `slack.unlink`, `slack.status` (which member apps are in the channel). Stubs, in the existing `teams` router.

## Check

- Migration applies. A test shows a second team cannot link the same channel and a team cannot link two channels.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
