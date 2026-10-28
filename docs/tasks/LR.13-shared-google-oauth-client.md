---
id: LR.13
title: Workspace-wide Google OAuth client for connectors on accounts.google.com
milestone: LR
size: S
status: in_progress
depends_on: [LR.11]
branch: task/LR.13-shared-google-client
lane: mcp
executor: claude
---

Dom, 28 Oct 2026. Google's authorization server has no dynamic client registration and no client ID metadata documents, so every MCP client needs a pre-registered Google client (`docs/reviews/tasks/LR.11.md`). Dom chose one shared client for the whole deployment, the same Google client his workspace-mcp gateway uses, instead of pasting it per connector.

## Scope
- New optional Worker secrets `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` (add to `.env.example` and the generated Env types; secrets, not wrangler vars).
- When a connector's authorization server is `accounts.google.com` and both are set, use them as the OAuth client automatically: no manual client dialog. A client the user typed on that connector still wins.
- When they're not set, behaviour stays as LR.11 left it (manual client dialog).
- Never send the secret to the browser or log it.

## Check
- Tests: Google server plus env client skips the dialog and the authorize URL carries the env client ID; a typed client wins; no env client keeps the dialog; a non-Google server ignores the env client.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-28: created; dispatched.
