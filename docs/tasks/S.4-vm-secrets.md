---
id: S.4
title: Secrets in the cloud agent Linux VM (proxy and env)
milestone: S
size: M
status: todo
depends_on: [S.3, C.14]
branch: task/S.4-vm-secrets
---

The Linux VM part of Dom's hybrid secrets design (see S.3).

## Scope

1. First, a short spike, recorded in the review file: confirm how Cloudflare Containers and the Sandbox SDK let a Worker intercept a container's outbound HTTP and HTTPS traffic and add headers. Cloudflare's `cloudflare/claude-managed-agents` template does this with outbound Workers. Use the same mechanism.
2. `proxy` secrets: the VM's outbound requests to granted hosts get the header from S.3's rules, and the value never enters the VM. `env` secrets: go into the environment of shell commands and skill scripts in the VM.
3. Redaction and events as in S.3.

## Check

Live on a local dev server with Docker: a Linux VM cloud agent's script and a `curl` from its shell both reach the echo server with the proxied header, and `env` shows no proxied value. An `env` secret is readable. The transcript shows `[secret:NAME]`. `bun run check && bun run test && bun run build` pass. The controller repeats the check on staging.

## Log
- 2026-10-17: added with the S.3 rewrite. Starts after S.3 and C.14 merge.
