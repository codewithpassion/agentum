---
id: WA.1
title: Workspace assistant, server side
milestone: WA
size: L
status: in_progress
depends_on: []
branch: WA-workspace-assistant
lane: services
executor: codex
---

Spec: `docs/v3/workspace-assistant.md` (all sections except the page layout).

## Scope
- `packages/db`: the two tables and their query functions, with a generated migration.
- `packages/services`: an assistant service (factory, built in `compose.ts`) that owns the loop, the tool list, the card tools, the confirm step, the key check and storage. `requireAgentManager` admits a user principal with `via: "session"`.
- `packages/mcp`: export what the assistant needs to build the tool list for a session principal (the names to leave out, the card tool definitions). `/mcp` behaviour does not change.
- `apps/web/src/server/trpc`: an `assistant` router (`list`, `get`, `send`, `resolveCard`, `archive`), thin as the rules say.

## Check
- Tests:
  - A member's assistant gets the agent tools and `send_message`, and not `grant_secret`, `revoke_secret`, `request_secret` or `request_model_key`. An admin's gets those four. Neither gets `create_secret`, `create_api_key`, `create_enrolment_code`, `delete_connector`, computer or browser tools.
  - The tool list on `/mcp` is unchanged for every principal kind (existing tests stay green; add one for a session principal if none exists).
  - With a fake model: a turn that calls `create_agent` creates the agent through the service and records the call and result; a turn that calls a destructive tool stops at a confirm card, and `resolveCard` with run and with don't-run each continue the loop with the right tool result.
  - `request_secret` stops the turn; `resolveCard` with `{ saved: true, ... }` and with declined both continue; a second `request_secret` with the same name in one turn is refused; `resolveCard` twice with the same `toolUseId` changes nothing the second time.
  - The secret value appears in no assistant table, no request to the model and no log line (assert on the fake model's received messages and the stored rows).
  - A message with `sk-ant-...`, `ghp_...`, a JWT or a PEM block is refused and nothing is stored; normal text with long words passes.
  - Tool results are scrubbed of workspace secret values before the model sees them.
  - The loop stops after 16 tool calls with a message.
  - Another member cannot list, read, send to or archive someone else's conversation, and a different workspace can't either.
  - No key: `send` answers with the builder's no-key message.
- `bun run check && bun run test && bun run build`, then the bundle grep for `drizzle` in `apps/web/dist/client`.

## Log
