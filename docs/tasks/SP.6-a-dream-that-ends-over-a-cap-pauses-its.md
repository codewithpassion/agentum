---
id: SP.6
title: "A dream that ends over a cap pauses its agent"
milestone: SP
size: S
status: in_progress
depends_on: [SP.5]
branch: task/SP.6-a-dream-that-ends-over-a-cap-pauses-its
lane: services-dream
executor: claude
---

From the spend walkthrough (`docs/reviews/SP-e2e.md`).

`enforceCap` is called from `runs.ts` only (the two places a turn ends, lines 2164 and 2303). TX.2 gave the team dream a `spend` dependency that asks `workspaceOver` before it runs and calls `enforceWorkspaceCap` after, but an agent's own dream has none. An agent dream's cost counts toward the week, but if it is the spend that crosses the cap, nothing pauses until some run finishes. A dream often runs when an agent is otherwise idle, so a cap passed by a dream can stay unenforced for days. I read this from the code and did not run it live. A dream needs a workspace Anthropic key, and the scripted model (DR.13) is not built.

## Scope

add `enforceCap` to the dream's `spend` dependency, and call it when an agent's dream ends and recorded usage. The team dream already does the workspace version. `compose.ts` already passes `spend` to the dream service.

## Check

a service test with the fake model. An agent at $0.99 of a $1.00 cap runs a dream that costs $0.02, and ends paused with reason `spend_cap` and a Needs you item. A dream under the cap pauses nobody. `bun run check && bun run test && bun run build` pass. Then repeat the walkthrough with the seeded dream rows.

## Log
- 2026-11-21: added from the spend walkthrough.
- 2026-11-21: dispatched.
- 2026-11-21: dispatcher stopped at the account monthly spend limit (HTTP 429). Work is saved in its worktree. Resume the same dispatcher after the limit resets on Nov 25.
