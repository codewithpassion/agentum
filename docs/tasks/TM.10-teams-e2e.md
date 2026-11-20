---
id: TM.10
title: "Teams walkthrough"
milestone: TM
size: M
status: todo
depends_on: [TM.4, TM.5, TM.6, TM.8, TM.9]
branch: null
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
