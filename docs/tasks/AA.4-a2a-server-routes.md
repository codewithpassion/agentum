---
id: AA.4
title: "A2A server routes: cards, JSON-RPC, HTTP+JSON, streaming, pairing endpoints"
milestone: AA
size: L
status: todo
depends_on: [AA.3]
branch: null
lane: worker
executor: claude
---

Spec: `docs/v3/agent-connections.md`, the sections "A2A mapping" and "Trust flows", plus the A2A spec at https://a2a-protocol.org/latest/specification/ and its proto. The design's list of picks on spec conflicts wins over the spec's prose.

## Scope
`apps/web/src/server/routes/a2a.ts`, a `bearerGroup` mounted at `/a2a`. Thin, same shape as `routes/triggers.ts`: read a capped body, authenticate, call the service, map the answer. No rules here.

- `GET /a2a/<publicId>/.well-known/agent-card.json`, public, with `Cache-Control` and `ETag`, built with `@repo/a2a`. Lists both interfaces, bearer in `securitySchemes`, `streaming` and `pushNotifications` true, and the pairing extension with `required: false`. An unknown or unpublished id gets 404.
- `POST /a2a/<publicId>/rpc`: every JSON-RPC method in spec section 9.4, with the error shape from the design.
- `/a2a/<publicId>/rest/...`: every HTTP+JSON route from the proto, including both verbs for `:subscribe`, with the `google.rpc.Status` error shape.
- Both bindings call one shared handler per operation, so their behaviour can't drift.
- For every request: `A2A-Version` checked as the design says, 401 with `WWW-Authenticate` before the body is parsed, the token's connection must match the `publicId` in the path, and 429 with `Retry-After` from the hourly limit.
- `SendStreamingMessage` and `SubscribeToTask` as SSE with each binding's framing. Poll the task row every 2 seconds in a `ReadableStream`, send the task first and then status and artifact events, close at a terminal or interrupted state, and close after 10 minutes so the client resubscribes. `SendMessage` blocks for at most 90 seconds.
- `GetExtendedAgentCard` answers `ExtendedAgentCardNotConfiguredError`.
- Pairing endpoints from the design: `POST /a2a/pair/join` (invite as bearer), `POST /a2a/<publicId>/pair/activate`, `/pair/decline`, `/pair/revoke` (connection token as bearer). Each calls the AA.2 service.
- `/connect/$token` is AA.7's route. Add nothing there here.
- A new page isn't involved, but `/a2a` must not be caught by Clerk redirects or CSRF. Confirm with a test on the real app wiring.

## Check
- Route tests in the repo's usual style cover, each as its own test:
  - Each operation on both bindings against the same fixtures, with identical outcomes.
  - The card validating against the `@repo/a2a` schema.
  - Missing token, wrong token, a revoked token, and another agent's `publicId` all refused without leaking which one failed.
  - A missing or wrong `A2A-Version`.
  - SSE framing per binding, closing at a terminal state, and resuming with `SubscribeToTask`.
  - An unpublished card returning 404.
  - An `hm_a2a_` token refused at `/mcp` and `/api/desk`.
- `bun run check && bun run test && bun run build` pass, and the bundle grep for `drizzle` in `apps/web/dist/client` is empty.

## Log
- 2026-10-31: created.
