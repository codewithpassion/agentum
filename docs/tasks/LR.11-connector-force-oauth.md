---
id: LR.11
title: Force OAuth on a connector whose server answers without a 401
milestone: LR
size: M
status: done
depends_on: []
branch: task/LR.11-connector-force-oauth
lane: mcp
executor: claude
---

Dom, 28 Oct 2026: adding `https://gmailmcp.googleapis.com/mcp/v1` as a connector doesn't offer OAuth. The server answers the unauthenticated probe without a 401, so the auth ladder in `packages/services/src/connectors/oauth.ts` (driven by the 401 and its `WWW-Authenticate`, see `connectors/mcp.ts`) never starts, and the connector is saved as needing no auth. Dom needs a way to force the auth setting.

## Scope
- When adding a connector, and on an existing connector's settings, the user can choose the authentication: automatic (today's behaviour, the default), OAuth, or none. Persist the choice on the connector.
- With OAuth forced, run the same discovery ladder without a 401: protected-resource metadata at the server's `/.well-known/oauth-protected-resource` (path-aware and root), then authorization-server metadata, then the existing fallbacks. If the authorization server has no dynamic client registration (Google doesn't), open the existing manual client dialog (`apps/web/src/components/connectors/oauth-client-dialog.tsx`) for client ID and secret, as for any no-DCR server today.
- Forced OAuth sends the bearer token on every call even if the server would answer without it. A forced choice is never overridden by a later probe.
- Find out what discovery `gmailmcp.googleapis.com` actually exposes (read-only HTTP requests are fine) and record it in the review file. If it needs scopes or parameters the ladder doesn't support, support them or record exactly what's missing.

## Check
- Tests: forced OAuth starts the ladder on a server that returns 200 unauthenticated; automatic still behaves as today; forced none never starts OAuth; the choice persists and survives a re-probe.
- Browser check on local dev: add a connector with OAuth forced and reach the authorization redirect (or the manual client dialog).
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-28: created from Dom's report; dispatched.
- 2026-10-28: merged at 0679744f, review clean. Adds D1 migration 0034. Dom: Google OAuth client for Gmail MCP.
