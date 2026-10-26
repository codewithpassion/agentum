---
id: X.7
title: Per-agent tool allowlist on a connector
milestone: X
size: S
status: done
depends_on: [M3.1, V1.3]
branch: task/X.7-connector-tool-allowlist
lane: worker
executor: claude
---

Requested by the morning-sweep work loop (ai-os-integration). The sweep reads Dom's Gmail through a Google Workspace MCP connector that exposes 121 tools, including send, label and trash. Today the only brake is "Ask me before" on each tool and the skill text. A prompt injection in an email should not be able to reach a send tool at all.

## Scope

- On the `agent_connectors` assignment, an optional `allowed_tools` list (tool names). When set, the agent sees and can call only those tools through the proxy and the `mcpServers` builder. When empty, nothing changes.
- Set it from the agent page connectors tab and expose it on the existing assign path.

## Check

- A stub MCP with `echo` and `shout`: an assignment with `allowed_tools: ["echo"]` lists only `echo` to the agent, and a direct proxy call to `shout` gets 403.
- An assignment without the list behaves as before.

## Log
- 2026-10-26: planned (from the morning-sweep loop).
- 2026-10-26: dispatched. Note: the `allowed_tools` column needs a migration while V2.1 (the V2 schema task) may run at the same time. Whichever merges second drops its own migration on `git merge main` and regenerates it with `bun run generate`, so numbers stay in order.
- 2026-10-26: review clean after 2 fix rounds; merged. Migration 0016 (agent_connectors.allowed_tools).
