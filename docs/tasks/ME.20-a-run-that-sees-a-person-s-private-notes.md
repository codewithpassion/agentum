---
id: ME.20
title: "A run that sees a person's private notes writes to their private file"
milestone: ME
size: S
status: done
depends_on: []
branch: task/ME.20-a-run-that-sees-a-person-s-private-notes
lane: services-memory
executor: claude
---

From the ME gate review, round 2 (`docs/reviews/ME-2.md`, MF-1). This was ME's second and last gate round, so ME closes when ME.20 and ME.21 merge. Private notes stay with their person (Dom, 19 Nov 2026).

## Scope

Make the write side use the read rule. In `scopeOf` in `packages/services/src/memory/provenance.ts`, a run's note takes `privateNotesUserOf(run, session)` from `library/private-notes.ts` as its `userScope`, instead of keying on `session.private`. A run in A's own `ui` or private session then writes to `private/<A>.md`, and every other run still writes shared notes. Hand-offs and subagents follow through their own sessions, which `runs.ts` already makes private to the parent's actor. A person's own "remember from chat" stays as it is, because that is the person's choice. Update `docs/v4/memory-format.md` to state one rule for reading and writing.

The cost is that the agent's shared memory stops learning from one-to-one app chats. Those notes go to the person's file, which matches what the agent dream already does with `ui` evidence. The controller can choose one of two other ways instead. One drops `origin === "ui"` from the rule, so only private sessions see private notes and app chats lose them. The other holds such shared notes for the person to approve. It must not hold them for the owner, because the owner would then see the private text.

## Check

Service tests: a `remember` from a run in A's non-private `ui` session lands in `private/<A>.md` with `userScope` A. B, the owner and an admin do not see it on Knows, in `memory.changes` or on the rail. A `remember` from a team room, Slack channel, artifact or Q&A run that A started still lands shared. A `remember` from A's Slack DM still lands private. A hand-off from A's `ui` session writes to A's file. Update the `service-notes.test.ts` cases that pin `RUN.ui` to `userScope: null`. `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-21: added from the ME gate review, round 2.
- 2026-11-21: dispatched on task/ME.20-a-run-that-sees-a-person-s-private-notes (v4 controller session).
- 2026-11-21: ready at e628d543 after one fix round, review clean. Queued for merge.
- 2026-11-21: merged 13bc42c4, merge check passed. Done.
