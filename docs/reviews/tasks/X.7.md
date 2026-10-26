# X.7 review

Task: per-agent tool allowlist on a connector.

## Verdicts

Round 1, at 0ee65ba: must-fix. A body `JSON.parse` could not read skipped the allowlist, and a Python connector (which accepts `NaN` and UTF-16) would still run it.
Round 2, at 3c0e118 (the fix): must-fix. A Go-style connector matches keys without case and with Unicode folding, so `NAME` next to `name` named one tool to the proxy and another to the connector.
Round 3, at f6fdb7d (the fix): clean, no must-fix. Two fix rounds.

## What changed

- `agent_connectors.allowed_tools` is a nullable JSON array of tool names (migration 0015 after the merge with main's 0014). Null and an empty list both mean every tool.
- `connectors.assign` takes an optional `allowedTools`. Leaving it out keeps the stored list, so changing the credential mode does not wipe it. An empty array clears it. Names are trimmed and deduplicated. `assignments` returns the list and `credentials.resolve` hands it to the proxy.
- The proxy (`routes/proxy.ts`, `routes/proxy-allowlist.ts`), when a list is set: answers 403 `tool_not_allowed` to a `tools/call` for any other tool and records a `connector.call` event with outcome `denied`. It cuts the `tools/list` answer (JSON, JSON batch, SSE) to the allowed names, and answers with an error when the answer cannot be read. It also refuses a body it cannot read as one call: a batch, invalid JSON, no method, or a key that is a case or non-ASCII variant of a protocol key.
- The `mcpServers` builder is unchanged. Every runtime (cloud, machine claim, managed agents) builds proxy URLs, so the proxy is the one place the list is enforced.
- Agent page connectors tab: a Tools column ("All tools" or "N of M tools allowed") and a "Choose tools" dialog over the connector's cached tool list.
- `scripts/dev/stub-mcp.ts` takes `shout: true` (and `--shout`) for a second tool, used by the proxy tests.

## Nits left

- Exact duplicate keys (`"name":"echo","name":"shout"`) are read last-wins by `JSON.parse`. A first-wins upstream parser would see the other tool. Closing it needs a raw key scan.
- A client reply to a server request (a body with `result` and no `method`) gets 403 when a list is set. The proxy has no server stream, so this should not occur.
- Only `tools/*` is restricted. `resources/read` and `prompts/get` still reach the connector.
- Dialog: unticking every tool and saving stores no list, which means every tool. "Select all" ignores the filter text. A connector with no cached tools cannot be restricted from the page.
- A malformed stored `allowed_tools` fails closed in the proxy (503) and breaks the `assignments` listing for that agent.
- The DELETE assertion in the allowlist proxy test is loose (not 403).

## Beyond the scope

- Restrict by tool annotation (read-only hint) instead of a name list.
- Let the dialog take typed tool names for a connector with no cached list.
- Apply the same list to resources and prompts.

## Steps for Dom

None. The migration is applied by `wrangler d1 migrations apply DB --remote` on the next deploy, as usual. To use it on the morning-sweep agent, open the agent's Connectors tab, press "Choose tools" on the Google Workspace connector and tick the read tools.
