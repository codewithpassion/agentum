# MCP management access (X.10, MA.1)

Agent management uses the same agent services and authorization as the app.
Write OAuth connections and write/admin API keys get `create_agent`,
`update_agent`, `archive_agent`, `restore_agent`, `set_agent_owners`,
`set_agent_ask_before`, `check_agent_address` and `reserve_agent_address`.
Read connections get `list_agents` and `get_agent` among these agent tools.
Runs, machines, triggers and Slack senders cannot use the management writes.

`adminWriteTools` retains `create_inbox_thread` for write/admin API keys only;
it does not grant that tool to OAuth connections. `adminSetupTools`, including
secret, API key, enrolment and connector deletion tools, remain admin-key only.
Connector assignment through create/update admits write OAuth connections, but
connector registry and credential management retain their existing restrictions.
Agent details read assignment metadata without reading connector credentials.

Every management write records `admin.action`. API key audits retain `keyId`
and `keyName`; OAuth audits use the user actor and include `clientId` and
`userId`, without manufacturing a key. Address availability is a read and does
not append an audit event.

Archived agents retain their slug and email reservations under the existing
unique indexes. Restore also explicitly refuses collisions with active agents,
uses archive authorization and appends `agent.updated`. It adds no UI control.
`get_agent` accepts archived ids and slugs. Its `updatedAt` comes from the latest
recorded configuration event, falling back to `createdAt`; there is no stored
agent update timestamp. `emailAddress` is null unless both a local part and a
mail domain are configured; `emailLocal` always reports the reservation.

There is no members MCP tool. Owners take Clerk user ids: `get_agent` shows
current owner, backup and creator ids; other ids come from the workspace
administrator. Omitted owner fields stay unchanged and null clears them.
