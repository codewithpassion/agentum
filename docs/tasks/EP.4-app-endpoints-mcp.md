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
- Update the descriptions of the `app` kind, `artifact_create`, `artifact_update` and `artifact_promote` in `packages/mcp/src/tools/artifacts.ts`. They cover `agentum.json` (hosts, secrets, endpoints, agents), the `/hooks/<id>` address (shown in settings and returned by `artifact_read` once approved), `env.AGENTUM.startRun`, the `reply` export, that the app checks its caller's signature, and that a bot ships a one-line `index.html`.
- `artifact_read` returns the artifact's active endpoint URLs.
- A worked example the descriptions point to, as an MCP resource or a short block in the `app` kind description: a Discord interactions handler that verifies Ed25519, answers PING, adds a role itself through `discord.com` with a secret placeholder, and hands `/ask` to an agent with the interaction token as `state` and a follow-up in `reply`.
- `scripts/e2e/app-bot.ts`: starts a dev server, publishes that example through MCP with a test Ed25519 key pair, approves the grants, sends signed requests to the endpoint, and asserts the direct answer and the reply, with a local mock standing in for discord.com.

## Check
- `bun scripts/e2e/app-bot.ts` passes.
- Cold-start check: a fresh agent that is given only the MCP tools of a local dev server and the goal "build a Discord slash command bot whose /ask hands off to an agent" publishes a working app without reading the repo. The dispatcher records its transcript summary in the review file.
- `bun run check && bun run test && bun run build` pass.

## Log
