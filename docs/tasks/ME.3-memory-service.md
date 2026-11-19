---
id: ME.3
title: "Memory service: notes, levels, scopes, guard rules"
milestone: ME
size: L
status: todo
depends_on: [ME.2]
branch: null
lane: services-memory
executor: claude
---

From `docs/v4/build-plan.md`, milestone ME. Fill `@repo/services/memory`. It is the only writer of memory files.

## Scope

- Every write goes through the library service so it gets a version, and inserts a `memory_changes` row in the same `atomic` call.
- Learn levels: `ask_first` holds every agent or dream note as `held` and raises a `memory_note` Needs you item. `tell_after` and `quiet` apply at once. A person's own add or edit always applies.
- Guard rules, enforced in code: a note whose only source is outside mail, a web page or an A2A peer is held whatever the level. A note matching a secret pattern is refused. Keep a small pattern set for API keys, tokens, passwords and card numbers in `memory/guards.ts`, with tests. Never-list topics are passed to callers as text for the model and are not pattern matched.
- Scopes: a note from a session with `private = true` goes to `private/<userId>.md`. Extend `packages/services/src/library/audience.ts` so only that person and the agent's runs for that person can read the file.
- `undo(changeId)` reverts one change. `rules.set` needs the owner or an admin on a browser session. A run principal can never change rules.
- `decide` approves or rejects a held note and clears the Needs you item.

## Check

- Service tests: each level, each guard rule, private scope visibility for three principals, undo, rules authz, the atomic write under a failed library write.
- No other module writes under `agents/<slug>/memory/`: add a test that the library write path refuses a run principal writing there directly.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
