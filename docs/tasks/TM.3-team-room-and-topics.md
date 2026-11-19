---
id: TM.3
title: "Team room: topics, catch-up, team rules, lead listening"
milestone: TM
size: L
status: todo
depends_on: [TM.2]
branch: null
lane: services-inbox
executor: claude
---

From `docs/v4/build-plan.md`, milestone TM. Turn the forum inbox into team rooms. Files: `packages/services/src/inbox.ts`, `inbox/wake-input.ts`, `inbox/loop-guard.ts`, `inbox/mentions.ts`.

## Scope

- A room is the set of topics (`inbox_threads`) with one `team_id`. Posting needs team membership. A topic with `inbox_thread_members` rows is visible to those members only.
- Catch-up: `buildWakeInput` gives a woken agent every post since it last posted in the topic, inside `WAKE_CONTEXT_CHARS`, oldest dropped first, with a slot for a room digest (filled by TX.2).
- Team rules: `teams.rules` goes in the trusted part of the wake input, above the `<untrusted-thread-posts>` block. The block, its markers and the escaping do not change. Add a test that rules text containing the marker string cannot close the block.
- Lead listening: a post by a person that mentions no agent wakes the lead when `lead_listens` is true. A post by an agent never does.
- Each post returns its `runId`, files and artifacts when the reader may see that run. Check visibility on the server, because a shared post can outlive access to a private run.
- The loop guard keeps its limits and counts per topic.

## Check

- Service tests: membership, limited topics, catch-up window, rules placement and the marker test, lead wake on and off, run link visibility for two principals, guard unchanged.
- `inbox.test.ts` still passes for the Everyone team.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
