# C.15 review: network access for isolate agents

Branch task/C.15-isolate-network. Final head is recorded in the dispatcher report.

## What was built

Agent setting "Network access" in `runtimeConfig.networkAccess`, on when missing, so existing agents need no backfill. The form shows it for cloud agents with one sentence and a note that Linux VM agents always have network. When on, an isolate run gets a `web_fetch` Pi tool and a `curl` command in the library shell, both calling one fetcher (`apps/web/src/server/web-fetch/`). The fetcher allows http and https only, refuses private, loopback, link-local, metadata and internal addresses and this Worker's own hosts, follows redirects by hand with the same check on every hop, caps the answer at 5 MB and the call at 30 s, and adds workspace credentials per hop through the existing `outboundFetch` credential proxy. Every request writes a `network.request` event with method, host, status, size and duration. When off, the tool is gone, the system prompt says so in one line, and `curl` answers "Network access is off for this agent." Event type list, services and compose changes need no migration.

## Verdicts

- Round 1 (47c5117): must-fix. Caller credentials followed a redirect to http or another port on the same host. The `library.command` event stored curl secrets.
- Round 2 (1cc81f7): must-fix. Regex redaction of curl lines missed option clusters and attached values.
- Round 3 (ba07552): must-fix. Same redaction, attached `-H` values and escaped quotes.
- Round 4 (b421714): must-fix. Line-based redaction missed a secret set on another line, in a file or in a pipe. The controller then dropped script parsing.
- Round 5 (b4c0320): clean. `library.command` logs `[script redacted: made network requests]` whenever the shell starts `curl` (decided at run time through `onCurl`, so spelling cannot fool it), and the requests have their own events.

## Nits left

- Tool inputs of `bash` and `web_fetch` are stored verbatim in `tool.call` run events (`pi-run-events.ts`), and `stripSecrets` misses a token inside a script or a `web_fetch` body. This was true of all tool inputs before C.15, but curl adds a new reason to type a token. The `library.command` redaction therefore protects external MCP callers, not the agent run transcript.
- `NETWORK_SCRIPT_REDACTED` is exported from `mcp/ports.ts` but the tests repeat the string.
- `sent = []` in the `test.each` cases of `library-bash.test.ts` is never asserted. No tests for alias, `eval`, `sh -c` and `xargs`, which the reviewer confirmed fire the hook.
- A script that defines a function named `curl` is logged as typed. Correct, since it sends nothing, but undocumented.
- Own-host check uses `PUBLIC_BASE_URL` and the MCP request host only. In PR previews `PUBLIC_BASE_URL` is empty, and workers.dev names are not on the list. Impact is low, an agent request carries no app credentials.
- A credentialed host's answer passes through `outboundFetch`'s own 10 MB buffer first, and over 10 MB comes back as a 502 instead of `too_large`.
- A public name that resolves to a private address (for example `127.0.0.1.nip.io`) is not caught, since a Worker cannot resolve DNS. Documented in `safe-url.ts`.
- On a cross-host 307 or 308, custom headers such as `X-Api-Key` and the body follow the redirect, as the fetch standard and `curl -L` do. Only authorization, cookie and proxy-authorization are dropped.
- `CROSS_ORIGIN_DROPPED_HEADERS` lists `proxy-authorization`, which `requestHeadersOf` already drops.
- `curl` always follows redirects, with no way to see a raw 3xx.
- The MCP `bash` tool gives `curl` only to a run whose agent has network on (and to Linux VM agents). People, API keys, machines and triggers get the "off" message, which reads oddly for a human.
- Skill scripts in the isolate (Dynamic Worker with `SecretsOutbound`) already had network and are not covered by this setting.

## Ideas beyond the scope

- Hide the switch, or show it disabled, when the environment is Linux VM. The Pi `web_fetch` path for a VM agent is not installed anyway.
- Redact `tool.call` inputs for `bash` and `web_fetch` in the run event log.
- Block `workers.dev` and preview hostnames of this app in the own-host check.
- An optional host allow list per agent.

## Steps for Dom

- Live check on staging (controller): an isolate agent fetches a public URL with `web_fetch` and with `curl`, then with the setting off both are refused.
- No migration, no new binding, no new secret.
