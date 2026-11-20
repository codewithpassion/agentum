---
id: TM.10
title: "Teams walkthrough"
milestone: TM
size: M
status: done
depends_on: [TM.4, TM.5, TM.6, TM.8, TM.9]
branch: task/TM.10-teams-e2e
lane: e2e
executor: claude
---

From `docs/v4/build-plan.md`, milestone TM. End-to-end check for TM.

## Scope

- Create a team of three agents with a lead. Post without a mention and see the lead answer and assign. Mention a member and see it catch up. Have the lead propose an instruction change and approve it as owner.
- Check a limited topic is hidden from a non-member, and a task link is hidden from a person who cannot see the task.
- Findings to `docs/reviews/TM-e2e.md`.

## Check

- The walkthrough passes on local with the fake runtime.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: from TM.5: the context budget does nothing on machine runs yet; the client passes only --effort because --autocompact isn't verified for Claude Code 2.1.300. Check whether a current Claude Code supports a compaction setting and record it. Controller decisions: keep the guessed compaction sizes (100k, 200k, 500k tokens); subagents keep their own setting and don't inherit the parent's.
- 2026-11-21: from TM.9: the team room composer has no dictation, which the old inbox composer had. Check whether it should, and file a task if so.
- 2026-11-21: dispatched.
- 2026-11-21: ready at f2cae094 after one fix round, review clean, browser pass at both sizes. Compaction finding: Claude Code 2.1.327 supports --autocompact but the client doesn't pass it, so TM.17 passes it with a version check. Dictation: controller decision, yes, the room composer gets dictation (TM.15). TM.12 to TM.18 added from the walkthrough. Queued for merge.
- 2026-11-21: merged 7928d659, merge check passed. Done.
