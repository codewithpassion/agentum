---
id: ME.14
title: "One rule for who may see a person's private notes"
milestone: ME
size: M
status: in_progress
depends_on: []
branch: task/ME.14-one-rule-for-who-may-see-a-person-s-priv
lane: services-library
executor: claude
---

From the ME gate review, round 1 (`docs/reviews/ME-1.md`, MF-1). Private notes stay with their person (Dom, 19 Nov 2026).

## Scope

Replace "the run is on behalf of that person" with one allow-list rule, used both by the prompt (`launch-context.ts`, `memory/prompt.ts`) and by the library (`resolveMember` in `library.ts`, so the library tools, the daemon routes, the VM sync and the audience in `library/audience.ts` follow). A run sees `memory/private/<userId>.md` only when its session is private or has origin `ui`, and the session's actor is that user. Every other session gets no private file: team rooms (`inbox`), Q&A, Slack channels, mail, artifact chats, A2A, routines and triggers. Hand-offs and subagents keep the rule through their own session's privacy, which `runs.ts` already derives. Drop the origin list from the prompt path so a Slack DM, which is private, gets its notes back. Apply the same rule to `search_history`, or record why not.

## Check

Service tests: a team room run started by A's post has none of A's private notes in its launch context and cannot read, list or stat A's private file through the library. The same for a Slack channel thread, an artifact session and a Q&A run. A Slack DM run for A, and a private `ui` run for A, both carry A's private notes. The audience sends a private path only to a run whose session passes the rule. Update the existing launch-context test that pins `slack` to no private notes. `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-20: added from the ME gate review, round 1.
- 2026-11-20: dispatched on task/ME.14-one-rule-for-who-may-see-a-person-s-priv (v4 controller session).
