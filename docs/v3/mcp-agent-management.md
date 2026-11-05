# Managing agents over MCP

Status: decided by Dom on 5 Nov 2026. Task MA.1.

## Why

A Claude session connected to Agentum through OAuth (the Claude connector, or Claude Code's `/mcp` sign-in) cannot create or change agents. `create_agent` and `update_agent` exist in `packages/mcp/src/tools/admin.ts`, but `server.ts` offers them only when `adminAccessOf(principal)` finds an `ag_key_` API key with `write` or `admin` access. `packages/services/src/admin.ts` checks the same through `requireKey`. Management tools the UI has (details, archive, owners, approvals, address) have no MCP tool at all.

## Decisions (Dom, 5 Nov 2026)

1. **Who.** A person's OAuth connection with write access gets the agent tools, in addition to write and admin API keys. Runs (agents themselves), machines, triggers, Slack senders and read-only connections still don't. An agent creating agents is out of scope.
2. **How far.** Secrets (`create_secret`, `grant_secret`, `revoke_secret`), API keys, enrolment codes and the other `adminSetupTools` stay admin-key only.
3. **Archive.** Archive is allowed and is not deletion. There is no delete tool. Because nothing can un-archive an agent today, add a restore.

## Tools

All go through the same services and authorization as the UI (`authorize` with `agents.create`, `agents.update`, `agents.archive`, `agents.read`), so a member can do over MCP exactly what they can do in the app, no more.

- `create_agent` and `update_agent`: unchanged inputs and behaviour, now also for an OAuth write connection.
- `get_agent({ agent })` (agent id or slug, as `list_agents` returns): name, slug, status, model, runtime, machine, instructions, connectors, skills, owner and backup, ask-before settings, email address if any, created and updated times. No secret values. Read access is enough, so read-only connections get it too.
- `archive_agent({ agent })`: sets the agent to archived (`agents.archive`). The result says it can be restored with `restore_agent`.
- `restore_agent({ agent })`: a new service method `agents.restore` that sets an archived agent back to active, with the same authorization as archive and an `agent.updated` event. It refuses if the slug or address is now taken by another active agent, with a clear message. The UI doesn't get a restore button in this task.
- `set_agent_owners({ agent, ownerUserId?, backupUserId? })`: wraps `agents.setOwners` (null clears). Takes Clerk user ids. The description says where to find them, through an existing members tool if there is one; otherwise it accepts what `get_agent` shows and documents that.
- `set_agent_ask_before({ agent, ... })`: wraps the agent profile's `setAskBefore`, with the same input shape as the UI.
- `check_agent_address({ local })` and `reserve_agent_address({ agent, local })`: wrap `agents.checkAddress` and `agents.reserveAddress`.

Every write keeps the audit record `admin.ts` writes today. For an OAuth caller, it names the OAuth client and the user instead of an API key id. Look at how `record()` stores the key and extend it. Don't fake a key.

## Gating changes

- `packages/services/src/admin-access.ts`: a way to admit a user principal that came in through OAuth with write access, for the agent actions only. `adminSetupTools` and secret and key actions keep requiring an admin key.
- `apps/web/src/server/routes/mcp.ts` (`adminAccessOf`) and `packages/mcp/src/server.ts`: offer the agent tools to write API keys and OAuth write connections, and the setup tools to admin keys only. Read-only connections get `list_agents` and `get_agent` only.
- `create_inbox_thread` sits in the same `adminWriteTools` group today. Keep it where its current rule puts it, unless moving it is trivial and obviously right; mention what you did.

## Docs

Update the tool descriptions, `CLAUDE.md` only if a rule changes, and `docs/v3` where admin API access is described (search for X.10 and `adminWriteTools`).

## MA.2: archived agents in the app (Dom, 5 Nov 2026)

Dom wants a way in the app to see archived agents and restore them.

- tRPC `agents.restore({ agentId })` (`workspaceProcedure`) calls `agents.restore` from MA.1. `agents.list` already takes `includeArchived`.
- `/agents`: below the table, a quiet "Archived (N)" toggle, shown only when N > 0. It opens a list of the archived agents: name, slug, when archived if known, and a **Restore** button on each row. The archived list is closed by default. A successful restore shows a toast ("Restored <name>"), moves the agent back into the main table, and refreshes the rail. A refused restore (its slug or address now taken) shows the service's message.
- `/agents/<id>` for an archived agent: a banner at the top, "This agent is archived. It doesn't run and isn't offered anywhere.", with a **Restore** button. Edit controls that make no sense while archived stay disabled or hidden.
- Restore uses the same rule as archive, so who sees the button follows the UI's existing archive permission.
- Phones: the toggle and rows work at 390px with 40px targets.
