# R.3 review

Task: connector call time limit, and the first of parallel connector calls hanging. Branch task/R.3-connector-call-timeout.

## Verdicts

- Round 1 (d908fdb): not clean, 1 must-fix, 9 nits.
- Fix round 1 (fd1b0a8), reviewed: clean, 0 must-fix, 3 nits.

The round 1 must-fix: no test ran the proxy's own timeout error through pi-durable. The client now turns the proxy's JSON-RPC error with `data.code: "timeout"` into a readable error result, skips the tool list refresh for it, and a harness test shows the run reaching its next model turn.

## Root cause

`pi-run-mcp.ts` sent every JSON-RPC request with id 1. A stateful Streamable HTTP MCP server keys in-flight requests by id (the MCP SDK's `_requestToStreamMapping` in `webStandardStreamableHttp.js`), and the Brain's `/mcp/:slug` is a Durable Object per session. A second request with an id already in the map replaces the first one's entry, so the first of several parallel calls never gets its response. The MCP spec forbids reusing an id within a session. Every request now takes the next id from a counter. The test models such a server and fails on the old code with a hang.

## What was built

- Proxy limit: `connectors.call_timeout_seconds` (migration 0012, default 60, 10 to 300, set with `connectors.setCallTimeout`, a "Time limit" button on the connectors settings page). The proxy reads it from `credentials.resolve`, stops a slow call, writes `connector.call` with outcome `timeout` and returns "<connector> <tool> timed out after N s. Try a smaller request or retry."
- Client backstop: the cloud MCP client gives up after 310 s (the 300 s maximum plus grace), for servers behind no proxy such as the platform's own `/mcp`. It returns the same kind of error result.
- Built-in tools audit: web_fetch 30 s (curl goes through it), library bash 10 s wall, skill scripts 30 s, Slack API 10 s and 30 s, VM exec 120 s by default. The Pi library read, write and edit tools use only the library service (D1 and R2, no network call-out), so they got no limit.

## Nits left

- `connector.timeout` stays in the event type list for old rows. `docs/architecture/index.html:2084` still lists it among the v1 types.
- The proxy and the client name the connector differently in their timeout messages (display name against server key). The model sees the key in tool names.
- `PROXY_CAP_MS` lives in `proxy.ts` but only `egress.ts` uses it, and a proxy test still checks its value.
- `failed()` in the proxy takes timeout details even for the unreachable case.
- The new harness test answers `initialize` with the timeout error too, so the error lands in session setup. A test for a stalled body after an abort is missing.
- A server that keeps its SSE stream open after sending the result now times out at the connector limit (60 s) instead of 5 minutes.
- The stored limit is not clamped in the proxy, and the column has no CHECK constraint. Only a direct database write could store a bad value.

## Ideas beyond the scope

- VM exec allows up to 600 s, above the connector maximum. Fine as compute, worth a look if the VM gets network access for agents.
- Wrap the Pi library tools in a deadline if a stuck R2 call ever shows up.

## Steps for Dom

- Run `wrangler d1 migrations apply DB --remote` (staging, then production) before deploying: migration 0012 adds the column.
- On staging, have an isolate agent make four parallel calls to the Brain connector and check that all four return. A slow-call check needs a connector limit of 10 s on a connector that takes longer.
