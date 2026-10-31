# AA.4 review

Clean after one fix round. `bun run check`, `bun run test` and `bun run build` pass at the head commit, and the `drizzle` grep in `apps/web/dist/client` is empty. `bun run test` once failed on `guest execution: HTTP cap/start, durable recovery, signed MCP and suggestions` (a Miniflare socket closed under load). It passes alone and nothing in AA.4 touches it.

## Verdicts

- Round 1 (8d3981f): not clean, three must-fix.
  - `/a2a` was mounted after `app.use("*", clerkMiddleware())`. On a dev instance (staging and previews hold dev keys) Clerk answered a browser-style request, and a bearer-less REST call, with a handshake 307.
  - The "test on the real app wiring" only grepped `server.ts` for the page fallback, and stayed green with the redirect present.
  - Cancelling an SSE stream did not stop the polling loop: the abort reached nothing and `iterator.return()` cannot interrupt a generator that is awaiting. Reads went on until `streamMs`.
  - All fixed in b8c0bea. `composeServices` moved above Clerk and `mountA2aRoutes` runs before it, and every path under `/a2a` ends in the group's own 404, so nothing falls through to the pages. The wiring test asserts the order in `server.ts`, and runs the real `clerkMiddleware` and `csrf()` on a stand-in app in `server.ts`'s order, with a control that shows the 307 when Clerk comes first. A per-request `AbortController` goes through the operations and `cancel()` aborts it. A quiet stream sends `: keepalive` comments every 30 seconds. Also done: `If-None-Match` as a list, `*` and weak tags, and the unrelated `bun.lock` bumps that `bun install` pulled in were reverted.
- Round 2 (b8c0bea, fix commits only): clean.

## What was built

- `packages/a2a`: `buildAgentCard` (both interfaces, bearer scheme, `streaming` and `pushNotifications` true, the pairing and hops extensions with `required: false`).
- `packages/services/src/a2a/connections.ts`: `authenticate(token, publicId?)` and the three pairing calls (`activate`, `declined`, `peerRevoked`) take the public id of the path and refuse a token that belongs to another agent. The routes always pass it.
- `apps/web/src/server/routes/a2a.ts` (bindings, card, pairing, mount), `a2a-ops.ts` (one handler per operation for both bindings, blocking `SendMessage`, the task event stream), `a2a-errors.ts` (what a refusal becomes), `a2a-fixture.ts` (test support). `apps/web` now depends on `@repo/a2a`.
- Tests: card and auth (27), operation parity across both bindings (29), streaming and blocking (46), pairing (16), token isolation at `/mcp` and `/api/desk` and the wiring (9).

## Decisions made in this task

- A refused credential is the same 401 for a missing token, a wrong token, a revoked connection and another agent's path. A `ForbiddenError` from a service after authentication (the connection ended mid-request) is the same 401.
- JSON-RPC errors are HTTP 200 with the error in the body, except the 401 and the 429, which are real statuses on both bindings. The version check runs after the credential check and, on JSON-RPC, after the body is read, so the error can carry the request id.
- `SubscribeToTask` on a task that has ended is `UnsupportedOperationError` (spec 3.1.6). On a task in an interrupted state it sends the task and closes, as the design says.
- The pairing routes answer plain JSON `{ error }` like `routes/triggers.ts`, not the A2A error shapes, because they are not A2A operations.
- Hourly limit: only `SendMessage` counts, as the design says (tasks per hour). The 429 comes from the service's `A2aRateLimitError`.

## Nits left

- The pairing routes read the body before they judge the bearer, so an oversized body gets 413 whatever the credential. A wrong bearer is 404 with no `WWW-Authenticate`, which follows the service's `not_found`. A body that is not JSON goes to the service as `undefined`, so a wrong credential never learns about the body.
- On JSON-RPC the version check follows the body parse, on REST it comes first. A missing version with a malformed body gets a different error on each binding.
- An oversized body is `InvalidRequestError` (HTTP 400 on REST, 200 on JSON-RPC), not 413.
- The fallback to the request origin for the card's URLs only serves a test fixture, because `publish` needs `PUBLIC_BASE_URL`. Every `not_found` is `TaskNotFoundError` and every `conflict` is `InvalidParamsError`, which reads oddly for a missing push configuration.
- A blocking `SendMessage` keeps polling up to 90 seconds after the client hangs up if the runtime never fires `request.signal`. A stream is stopped by the response's own `cancel()`, which does fire. `wrangler.jsonc` sets only `nodejs_compat`, and `enable_request_signal` may be needed for `request.signal`. Not verified against workerd.
- `rowByInboundToken` joins the cards table even when no public id is given, and the optional `publicId` means a future caller that leaves it out skips the path binding.
- Tests: the keepalive test covers REST GET only, the cancel test checks elapsed time and not that reads stop, and `process.env.CLERK_TELEMETRY_DISABLED` is set at module level.

## Ideas beyond the scope

- A guard in `server.ts`'s own tests (or a boundary lint) that nothing is mounted at a path under `/a2a`, `/mcp`, `/api` after `clerkMiddleware` without a reason.
- A workerd check that an idle SSE response survives its keepalive past 100 seconds, and that `request.signal` aborts on disconnect (see the nit above).
- The pairing-code flow (the 200 `TASK_STATE_REJECTED` answer to an unknown token) is AA.9's, so it is not here.

## Steps for Dom

None that need an account. When a deployment exists, check on staging that `GET /a2a/<publicId>/.well-known/agent-card.json` answers 200 in a browser tab (Clerk's dev instance must not redirect it), and that a Hermes agent can call the JSON-RPC interface (AA.8 does this against a real Hermes).
