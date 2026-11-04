---
id: EP.4
title: MCP descriptions and example so a Claude over MCP can build a bot
milestone: EP
size: M
status: todo
depends_on: [EP.2, EP.3]
branch: null
lane: mcp
executor: codex
---

Spec: `docs/v3/app-endpoints.md`, section "MCP".

## Scope
- Offer the artifact tools (`artifact_create`, `artifact_update`, `artifact_read`, `artifact_list`, `artifact_test`, `artifact_promote`) to a person connected over MCP, not only to runs: a user principal from an API key with write access or more, or from an approved OAuth client. Today `apps/web/src/server/mcp/ports.ts` wires `artifacts` for `principal.kind === "run"` only. The owner of what they make is that user. Approving grants stays a browser action in Needs you, so no MCP caller can approve its own app; check that no tool or route lets a key or OAuth principal decide a grant.
- Update the descriptions of the `app` kind, `artifact_create`, `artifact_update` and `artifact_promote` in `packages/mcp/src/tools/artifacts.ts`. They cover `agentum.json` (hosts, secrets, endpoints, agents), the `/hooks/<id>` address (shown in settings and returned by `artifact_read` once approved), `env.AGENTUM.startRun`, the `reply` export, that the app checks its caller's signature, and that a bot ships a one-line `index.html`.
- `artifact_read` returns the artifact's active endpoint URLs.
- A worked example the descriptions point to, as an MCP resource or a short block in the `app` kind description: a Discord interactions handler that verifies Ed25519, answers PING, adds a role itself through `discord.com` with a secret placeholder, and hands `/ask` to an agent with the interaction token as `state` and a follow-up in `reply`.
- `scripts/e2e/app-bot.ts`: starts a dev server, publishes that example through MCP with a test Ed25519 key pair, approves the grants, sends signed requests to the endpoint, and asserts the direct answer and the reply, with a local mock standing in for discord.com.

## Check
- Tests: an API key with write access and an approved OAuth client see and can use the artifact tools; a read key sees only the read-only ones; neither can decide a grant.
- The browser check moved from EP.2: with that API key, publish an app with an endpoint through MCP, approve it in Needs you, copy its address from the artifact's settings, curl it, disable it, curl again for a 404.
- `bun scripts/e2e/app-bot.ts` passes.
- Cold-start check: a fresh agent that is given only the MCP tools of a local dev server and the goal "build a Discord slash command bot whose /ask hands off to an agent" publishes a working app without reading the repo. The dispatcher records its transcript summary in the review file.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-05: scope grew. Dom asked that Claude reaching Agentum over MCP can create bots, and the artifact tools are offered to runs only, so this task opens them to people (write keys, OAuth). It also takes EP.2's browser check.
