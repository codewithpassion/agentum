---
id: S.3
title: Workspace secrets for agents (proxy or env var)
milestone: S
size: L
status: done
depends_on: [C.12, M8.3]
branch: task/S.3-agent-secrets
---

Asked for by Dom on 17 Oct 2026: skills and scripts need API keys such as `OPENAI_API_KEY`, on every surface. Dom chose the hybrid. Each secret is delivered either by a proxy that adds it to outgoing requests, so the code never sees it (as Cloudflare's Managed Agents template does), or as an environment variable. The Linux VM backend (C.14, still being built) gets its part in S.4.

## Scope

- **Store.** An encrypted secrets store per workspace, encrypted with `SECRETS_KEY` like connector secrets.
  - Each secret has a name (a validated env var name), a value, and a delivery mode: `proxy` or `env`.
  - A `proxy` secret also has one or more rules: a host (exact, or a `*.` wildcard) and a header with a template, for example `Authorization: Bearer {value}` or `x-api-key: {value}`.
  - Values can be replaced or deleted, and are never shown again after saving.
  - There's a Settings page to manage secrets, and the agent page grants secrets to that agent. Use existing shadcn components only.
- **Cloud isolate (C.12 Dynamic Worker).**
  - `proxy` secrets: point the script isolate's `globalOutbound` at a Harbourmaster outbound entrypoint. It adds the header for requests whose host matches a granted rule, and passes other requests through unchanged. The value never enters the isolate.
  - `env` secrets: go into the isolate's `env`.
- **Managed Agents (Anthropic's cloud environment).** We don't control its network, so:
  - `env` secrets go in through whatever the API supports for environment or session variables, or a vault. Record which in the review file.
  - `proxy` secrets go through an explicit relay route, `/api/egress/<host>/<path>`, authenticated with the run's token. It forwards only to hosts in the agent's granted rules and adds the header.
  - The skill guidance tells managed agents which relay URL to use for each proxied host.
- **Machines.** `env` secrets go into Claude Code's environment through the run. Secrets in `proxy` mode use the same explicit relay as Managed Agents, and the guidance says so. No local HTTPS proxy.
- **Everywhere.**
  - Remove granted secret values from transcripts, tool output and Log entries before they're stored or shown, replacing each with `[secret:NAME]`.
  - Add an event each time a run receives secrets or the proxy or relay adds one, with names and hosts only, never values.
  - Harbourmaster's own secrets, run tokens and the workspace model key are never delivered.
- **Out of scope:** per-skill grants. The Linux VM is S.4.

## Check

Service tests:
- Secrets are stored encrypted, and no read returns a value.
- Grants are per agent.
- Host matching works, including wildcards and a host that isn't granted.
- Redaction works.
- The relay refuses hosts that aren't granted, and calls without a valid run token.

Live on a local dev server, with the workspace key from `apps/web/.env.local` and a local echo server exposed through a cloudflared quick tunnel (`--config /dev/null`):
- **Cloud isolate:** a skill script calls the echo server. A `proxy` secret's header arrives at the echo server, and the script's own `process.env` doesn't have the value. An `env` secret is readable by the script.
- **Managed agent:** an `env` secret is readable in its sandbox, and a call through the relay reaches the echo server with the header.
- **Machine:** an `env` secret reaches the agent, using the fake agent or Claude Code as in the earlier smoke runs.
- **Redaction:** the transcript and Log show `[secret:NAME]`, never a value.
- **No grant:** an agent without the grant gets nothing.

`bun run check && bun run test && bun run build` pass, and the bundle grep for `drizzle` passes.

## Log
- 2026-10-17: rewritten after Dom chose the hybrid (proxy where we control egress, env vars elsewhere, all surfaces); dispatched on task/S.3-agent-secrets. The VM part is S.4, after C.14.
- 2026-10-17: review clean after 3 fix rounds (fourth review allowed by controller) at d85692a (docs/reviews/tasks/S.3.md). Merged. Managed env secrets are vault credentials: placeholder in the sandbox, swapped on outbound; reachable via an echoing host. Machines need install-service re-run (SETENV).
