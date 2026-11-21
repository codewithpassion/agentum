---
id: TM.20
title: "A lead's room run gets no shell, file or web tools"
milestone: TM
size: S
status: done
depends_on: []
branch: task/TM.20-a-lead-s-room-run-gets-no-shell-file-or
lane: runtimes
executor: claude
---

From the TM gate review, round 1 (`docs/reviews/TM-1.md`, must-fix 2).

## Scope

- `buildLaunchContext` already works out `inLeadRoom` from `leadRoomOf`. Expose it on `LaunchContext` as `teamRoom`.
- Cloud (`pi-run.ts`, `pi-run-gate.ts`): in a room run, install no file-writing, shell or `web_fetch` tool. Pi's read-only file tools may stay.
- Machine (`runs/machine-claim.ts`, `apps/agentum/src/claude.rs`): the claim carries `teamRoom`, and the client starts Claude Code with only read tools and the Agentum MCP server allowed (`--allowedTools` or `--disallowedTools`), keeping `bypassPermissions` otherwise. An older claim without the field behaves as today.
- Managed (`managed/gateway.ts`, `managed/service.ts`): a room run's session has the agent toolset off, or its write, bash and web tools disabled in its configs.
- In its own conversations the lead keeps every tool, as TM.4 says.

## Check

- Per runtime, a test that a lead's room run has no write, shell or web tool and the same agent's `ui` run has them. `cargo test` for the client flag.
- `bun run check && bun run test && bun run build` pass, including the agentum-rs tests.
## Log
- 2026-11-21: added by controller.
- 2026-11-21: dispatched.
- 2026-11-21: dispatcher stopped at the account monthly spend limit (HTTP 429). Work is saved in its worktree. Resume the same dispatcher after the limit resets on Nov 25.
- 2026-11-21: spend limit reset, same dispatcher resumed.
- 2026-11-21: ready at 1de295c1, review clean after 1 fix round. Dom: machines whose agent leads a team need the updated Agentum client, since room runs now go only to a daemon reporting the team-room feature.
- 2026-11-21: merged 82f5487c, merge check passed (agentum-rs tests included). Done.
