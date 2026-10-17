---
id: S.3
title: Workspace secrets passed into agent VMs
milestone: S
size: M
status: todo
depends_on: [C.14, M8.3]
branch: task/S.3-agent-secrets
---

Asked for by Dom on 17 Oct 2026: skills and scripts need API keys such as `OPENAI_API_KEY`, passed into the VMs. Today scripts get no secrets on purpose.

## Scope

- An encrypted secrets store per workspace, encrypted with `SECRETS_KEY` like connector secrets. Secrets have a name (an env var name, validated) and a value. A secret can be replaced or deleted, and its value is never shown again after saving. There's a Settings page to manage them, and the agent page grants secrets to that agent. Use existing shadcn components only.
- Granted secrets are passed as environment variables into the VMs:
  - the cloud agent's Linux VM (C.14), in the environment of shell commands and skill scripts
  - the Managed Agents sandbox (M8.1/M8.3), through whatever the API supports for session or environment variables, or a vault. Record the mechanism in the review file.
  
  Only secrets granted to the agent go in. Harbourmaster's own secrets, run tokens and the workspace model key never do.
- Remove granted secret values from transcripts, tool output and Log entries before they're stored or shown, replacing each with `[secret:NAME]`. Add an event each time a run receives secrets, with the names only.
- Out of scope: the cloud isolate backend, machine runs, per-skill grants, and a credential-adding egress proxy. List them in the review file as follow-ups.

## Check

Service tests: secrets are stored encrypted, values are never returned by any read, grants are per agent, and redaction replaces values in text. Live on a local dev server with Docker and the workspace key from `apps/web/.env.local`: a secret `HM_TEST_SECRET` with a random value, granted to a Linux VM cloud agent. A skill script that prints the length of `process.env.HM_TEST_SECRET` and makes an HTTP request with it as a header to a local echo server returns the right length. The transcript and Log show `[secret:HM_TEST_SECRET]`, never the value. An agent without the grant sees the variable as unset. Repeat the env check on a managed agent. `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-17: added at Dom's request ("into the VMs"). Starts after C.14 merges.
