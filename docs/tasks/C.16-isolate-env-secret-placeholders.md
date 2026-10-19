---
id: C.16
title: Env secrets in the isolate as placeholders, filled in on the way out
milestone: C
size: M
status: done
depends_on: []
branch: task/C.16-isolate-env-secret-placeholders
---

Asked for by Dom on 19 Oct 2026. An "env" secret becomes an environment variable on machines and the Linux VM. The isolate's shell (C.15) has no environment, so granting an env secret to an isolate agent is accepted and then does nothing: Dom's Supadata key worked for a VM agent and silently failed for an isolate agent. Proxy secrets already work in the isolate through `outboundFetch` (`packages/services/src/secrets.ts`, rules with host and header). Dom chose placeholders, so the real value never enters the isolate.

## Scope

- An env secret gets an optional "Allowed hosts" list (reuse the proxy rules' host matching in `secrets.ts`, same wildcard rules). Show it on Settings, Secrets for env secrets, with one sentence on what it does. Store it alongside the secret; generate the migration if one is needed.
- In an isolate run, every env secret granted to the agent is visible in the library shell as a variable whose value is a placeholder, `hm-secret:<NAME>` (for example `$SUPADATA_KEY` expands to `hm-secret:SUPADATA_KEY`). `web_fetch` takes the same placeholder text in its URL, headers and body.
- In the C.15 fetcher (`apps/web/src/server/web-fetch/`), before each hop: find placeholders in the URL, header values and a text body. For each one, if the secret is granted to this agent and the hop's host is in its allowed hosts, replace it with the real value. If the host isn't allowed, or the secret has no allowed hosts, refuse the request without sending it, with a clear message ("SUPADATA_KEY may only be sent to api.supadata.ai" or "SUPADATA_KEY has no allowed hosts. Add them in Settings, Secrets."). A redirect to another host re-checks, and the real value never follows to a host that isn't allowed.
- Record a `secrets.used` style event (reuse the existing "secrets added to a request" event if there is one) with secret names and host, never values. A refusal writes a `network.request` refused event with the reason.
- The real value never reaches the sandbox, the tool result, the transcript or the Log. Error messages and response bodies echoed back are not scanned (the server may echo; that is the server's answer), but our own messages never include values.
- VM and machines keep env secrets as real environment variables, unchanged in this task.
- Silent failure fix: the agent's Secrets tab shows, for an isolate agent, which granted secrets work and how ("proxy: added for api.x", "env: placeholder, allowed hosts api.y", "env: no allowed hosts, won't work here"). The agent's system prompt lists the env secrets available as placeholders with their allowed hosts, names only.

## Check

- Tests: a placeholder in a header, URL and body is replaced for an allowed host; refused for another host and for a secret with no allowed hosts; a redirect from an allowed to another host doesn't carry the value; an ungranted secret's placeholder is refused; the event has names and host only; `$NAME` in the shell expands to the placeholder; the Secrets tab shows each status.
- `bun run check && bun run test && bun run build` pass.
- Live on staging (Dom and controller): Dom's Supadata secret with allowed host `api.supadata.ai`, granted to the isolate agent; in a new chat, `curl -H "x-api-key: $SUPADATA_KEY" https://api.supadata.ai/...` works, and the same placeholder sent to example.com is refused.

## Log
- 2026-10-19: added at Dom's request. dispatched.
- 2026-10-19: review clean after 4 fix rounds at 7795a22 (docs/reviews/tasks/C.16.md); round 3 approved by the controller (same-origin redirects after a fill), round 4 a one-commit statusText fix by the dispatcher. Merged. Migration 0011. Staging check pending (Dom's Supadata secret).
