# Staging cloud agent check, 17 Oct 2026

Live on https://harbourmaster-staging.rockyshoreslabs.io, in the Dev Workspace test organisation, signed in with `bun run agent-login --env staging`. Cloud agent `c-smoke` on Haiku 5.5. Result: 9/9 passed.

1. Workspace Anthropic key saved on `/settings/managed-agents`.
2. Cloud agent created with runtime "cloud (Cloudflare)" and model `haiku`.
3. Chat reply.
4. `/mcp` path: `harbourmaster_bash` wrote and read back `/library/c-smoke/mcp.txt`.
5. `/api/proxy` path: `scripts/dev/stub-mcp.ts` behind a cloudflared quick tunnel, added as connector `c-smoke-stub`. The agent called `echo`, and the Log shows `connector.call`. A connector assigned after the session started worked on the next message.
6. C.8: Pi's built-in `read` and `edit` changed the library file, and `/library` shows the change.
7. C.7: a skill codeword, an attached PNG, and an attached text file all reached the agent.
8. The Durable Object fetched its own origin with no 1042, 5xx or MCP initialize failure, so C.5's loopback fallback isn't needed.
9. The key was removed afterwards, and the stub and tunnel were stopped. Left on staging: agent `c-smoke`, skill `c-smoke-skill`, connector `c-smoke-stub`, `/library/c-smoke/mcp.txt`.
