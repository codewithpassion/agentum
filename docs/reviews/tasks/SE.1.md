# SE.1 review

Shared Google OAuth client only for Google hosts.

## Change

`onGoogle` and `sharedClientApplies` now take the connector's URL. The shared client applies only when the URL is https on `googleapis.com` or a subdomain, and both OAuth endpoints are Google's. The check runs at start (`clientFor`), at store (`store`), at refresh (`refreshAsHolder`) and in the connector summary.

## Verdicts

Round 1 (336afba): clean, no must-fix.

## Nits left

- Every `*.googleapis.com` host is allowed, including `storage.googleapis.com`. Listing only known MCP hosts would be tighter.
- No test for an `http://` URL on `googleapis.com`. The code refuses it.
- The lookalike host (`gmailmcp.googleapis.com.evil.example`) is tested at start only.

Two stale comments (connector-oauth.ts, compose.ts) were fixed after the review.

## Ideas beyond scope

- Narrow the allowlist to the known Google MCP hosts once Dom lists them.

## Not verified

- Staging checks, which belong to the controller.
- In a full `bun run test`, `guest execution: HTTP cap/start, durable recovery, signed MCP and suggestions` (apps/web live-artifacts) failed under load. It passed when `apps/web` ran alone per the reviewer, and one run of mine failed it with a socket error. It is unrelated to connectors. Also one `packages/services` timing test ("an hour of never-claimed runs") failed once under load and passed on rerun.

## Dom

Nothing needed.
