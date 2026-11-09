# Platform MCP

The platform tools bind to service ports supplied by the web app. The tool
package does not access the database or decide who the caller is. Services
check permissions for every operation.

Agent tools include `list_agents`, `send_message`, `get_run` and `cancel_run`.
An enabled run also gets `start_subagent`, `subagent_status`,
`message_subagent`, `stop_subagent` and `list_subagents`; a level-2 subagent
gets the management tools but cannot start another helper. Computer agents
cannot start subagents; machine agents require a daemon with `parallel-subagents`.
The `tools` input narrows connector tool names only; built-in shell and file tools
are not limited. Turning Subagents off preserves status, stop and list for
existing helpers. See
[Subagents](../../docs/v3/subagents.md) for access, model and lifetime rules.

Other groups cover sessions, inbox, routines, triggers, skills, the library,
wiki, artifacts and documents. Mail, browser, computer and management tools are
offered according to the caller's capabilities. `src/server.ts` composes the
registered tool groups.
