# LR.11 review: force OAuth on a connector whose server answers without a 401

## Verdict

Round 1 (a49911ff, Sonnet high): no must-fix in the code. The one must-fix was this file, the missing record of what gmailmcp.googleapis.com exposes. It is below. Clean after 0 code fix rounds.

## What was built

A connector stores `auth_mode` (`auto`, `oauth`, `none`, default `auto`, migration 0034). Automatic keeps the probe-driven behaviour. Forced OAuth runs the same discovery ladder with no 401 (protected-resource metadata path-aware then root, then authorization-server metadata, then the origin fallback) and refuses to save when the server publishes no metadata. Forced none never starts OAuth. A forced mode is stored and no probe changes it: only `connectors.setAuthMode` does. The add dialog has an Authentication select, each row has an Auth dialog, and the manual client dialog opens by itself when the server has no dynamic client registration. The bearer for an OAuth connector comes from its stored credential on every call (`credentials.ts`), whatever the server would answer without it.

## What gmailmcp.googleapis.com exposes (read-only requests, 28 Oct 2026)

- `initialize` and `tools/list` both answer 200 with no token, so automatic saves it as no auth. A bad bearer gets 401 with `WWW-Authenticate: Bearer realm="https://accounts.google.com/", error="invalid_token"`, no `resource_metadata`.
- `/.well-known/oauth-protected-resource/mcp/v1` answers 200: `authorization_servers: ["https://accounts.google.com/"]`, `resource: https://gmailmcp.googleapis.com/mcp/v1`, `scopes_supported` with 11 Gmail scopes (mail.google.com, compose, drafts, labels, metadata, modify, readonly, send, settings.basic and others). The root path answers 404. The ladder finds the path-aware one first.
- accounts.google.com publishes `oauth-authorization-server` and `openid-configuration` with authorization endpoint `/o/oauth2/v2/auth`, token endpoint `oauth2.googleapis.com/token`, S256 PKCE, `client_secret_post` and `client_secret_basic`, and no `registration_endpoint`. The manual client dialog (client ID and secret) is the path.
- Google returns a refresh token only with `access_type=offline` and `prompt=consent`. The ladder did not send them, so a login would have ended after an hour. `buildAuthorizeUrl` now adds both for accounts.google.com.
- Browser check on local dev: added `https://gmailmcp.googleapis.com/mcp/v1` with OAuth forced, the client dialog opened, a typed client then led Connect to accounts.google.com (it answered `invalid_client` for the fake ID, as expected).
- Not verified without a real client: whether Google's token endpoint accepts the RFC 8707 `resource` parameter we send (the authorize endpoint did not reject it before the client check).
- Scopes: `scopeFor` requests every advertised scope, including full `mail.google.com`, send and settings. That is broad for Google's consent screen and app verification. There is no per-connector scope override.

## Nits left

- `setAuthMode` deletes credentials and oauth states on a kind change without the live-run guard `remove()` uses.
- A re-probe overwrites the cached tool list with the anonymous one even when the connector keeps its login.
- A server whose unauthenticated probe errors (400 or 405) cannot be saved even in a forced mode.
- Forced none on a server that answers 401 saves `ok` with no tools.
- A kept OAuth config keeps stale discovery, not just the typed client.
- Automatic on a header or OAuth connector whose server answers anonymously turns it into none and drops credentials.
- The Header name field shows for OAuth and none. The "forced" label does not name the mode.
- Missing tests: bearer on every call after forced OAuth, header to OAuth switch, auto through `setAuthMode`, forced OAuth on a 401 server.
- `apps/web` `guest-execution.test.ts` fails on main too (10 s fetch failure in this sandbox), so `bun run test` exits 1 here for that file only.

## Ideas beyond scope

- A per-connector scope list, so Gmail can be limited to readonly or compose.
- A "re-probe tools" action that does not touch auth.

## Steps for Dom

- Create a Google Cloud OAuth client (Web application) with redirect URI `<app origin>/api/connectors/oauth/callback`, enable the Gmail API, then add the connector with OAuth forced and paste the client ID and secret. The Gmail scopes need the app in testing mode with Dom's account as a test user.
- Apply migration 0034 to remote D1 on deploy.
