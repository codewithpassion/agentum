---
id: SE.1
title: Shared Google OAuth client only for Google hosts
milestone: SE
size: S
status: todo
depends_on: []
branch: null
lane: services
executor: claude
---

From the 10 Nov 2026 review (M2). The workspace's shared Google OAuth client can be applied to a connector whose server is not Google, so that server receives a colleague's Google token. Start at `packages/services/src/connectors/oauth-config.ts` and `connector-oauth.ts`, and the start route in `apps/web/src/server/routes/connectors-oauth.ts`.

## Scope

- Apply the shared Google client only when the connector URL's host is on a Google host allowlist.
- Check again when the token is stored and when it is refreshed.

## Check

- A failing test first: a connector on a non-Google host asks for the shared client and is refused at start, store and refresh. A Google host still works.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-10: added from the 10 Nov review, after Dom's decisions (members are trusted with credentials, the assistant may approve skills, assistant conversations share the thread list and are marked).
