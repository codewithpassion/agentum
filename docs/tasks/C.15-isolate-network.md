---
id: C.15
title: Network access for isolate agents, on by default, switchable per agent
milestone: C
size: M
status: todo
depends_on: []
branch: task/C.15-isolate-network
---

Asked for by Dom on 19 Oct 2026. Cloud agents in the isolate environment have no network. The library shell tool says "curl, python3, sqlite3, tar and js-exec are not available, and there is no network" (`packages/mcp/src/tools/library.ts:44`), and Pi in the isolate has no fetch tool. Dom wants network access by default, with a setting to turn it off. Linux VM agents already have outbound access through the egress intercept (C.14); reuse its logging and blocking rules where they fit.

## Scope

- Agent setting "Network access", on by default for new and existing cloud agents, stored in `runtimeConfig`, shown in the agent config with one sentence on what it allows. It only affects the isolate environment; say in the UI that VM agents always have network.
- When on: a `web_fetch` tool for isolate runs (URL, method, headers, body; text or base64 response with status and headers; response capped at 5 MB, 30 s timeout), and `curl` in the isolate's library shell, routed through the same fetch path. Update the shell tool's description.
- Blocking: no private, loopback, link-local or Cloudflare-internal addresses, no requests to this Worker's own hosts, and http and https only, checked after redirects too. Reuse the VM egress rules if they exist.
- Every request is recorded in the Log as an event with method, host, status, size and duration, the way VM egress is logged. Never log bodies, query strings with secrets, or auth headers.
- Credentials: requests go out without workspace secrets unless the agent's existing credential proxy (M3.3) applies to that host; reuse it where the codebase already routes VM requests through it.
- When off: no `web_fetch` tool, `curl` reports that network access is off for this agent, and the system prompt says so in one line.

## Check

- Tests: the setting defaults to on; off removes the tool and makes curl refuse; private, loopback and metadata addresses are refused, including after a redirect; the 5 MB cap and timeout apply; a request writes a Log event without the body or auth headers.
- `bun run check && bun run test && bun run build` pass.
- Live on staging (controller): an isolate agent fetches a public URL with `web_fetch` and with `curl`; after turning the setting off, both are refused.

## Log
- 2026-10-19: added at Dom's request.
