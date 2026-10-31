---
id: AA.5
title: "A2A client, outbound tasks, webhooks, outbox delivery and wakes"
milestone: AA
size: L
status: todo
depends_on: [AA.3]
branch: null
lane: mcp
executor: claude
---

Spec: `docs/v3/agent-connections.md`, the sections "Our agent calling a peer", "Trust flows" and "Decisions" (the transport row). It wins over anything else.

Lane is `mcp` so this can run beside AA.4. Put routes for this task in their own file, `apps/web/src/server/routes/a2a-webhooks.ts`, and mount it in the same place AA.4 mounts `a2a.ts`, so the two merge cleanly.

## Scope
- `packages/a2a/src/client.ts`: an A2A client taking an injected `fetch`. It reads a card, picks the first interface it supports (JSON-RPC or HTTP+JSON), and offers `sendMessage`, `getTask`, `cancelTask` and `createPushConfig`. It sends `A2A-Version: 1.0`, applies the credential for the connection's scheme, includes OAuth2 client credentials with a token cached in memory for that call chain only, and validates every response with the schemas. It treats anything from a peer as untrusted.
- The transport port from AA.2, made real in `apps/web/src/server`: `safeFetch` from `connectors/safe-url.ts` with redirects refused, HTTPS required outside dev, a 15 second timeout, and in-process dispatch when the origin is `PUBLIC_BASE_URL`, because a Worker can't fetch its own hostname. Check how `server.ts` exposes the app so this doesn't create an import cycle.
- `packages/services/src/a2a/outbound.ts`: `send` applies `outbound_policy` (off refused; `approve` goes through a run request whose card shows the peer and the full text, then sends; `auto` sends), the hourly limit, and the hop count from the calling run's depth. It stores an `a2a_outbound_tasks` row keyed by `requestId` so a retry doesn't send twice. It registers a per-task webhook when the card supports push, and always sets polling for at most 24 hours. It always sends its own `contextId`. If `SendMessage` hits the client timeout, it finds the task with `ListTasks` by that context and goes on polling, because Hermes ignores `returnImmediately` and can hold a call for 300 seconds. `get` answers in the `RunInfo` shape `send_message` and `get_run` already use.
- `POST /a2a/webhooks/<taskId>/<token>`: the token in the path is checked against the task's hash, the body is ignored, and the handler reads the real state with `GetTask` using our credential, then updates the row. It is idempotent. A revoked connection gets 401. See "Hermes compatibility" in the design: Hermes signs pushes with a secret we don't hold and cuts the text to 2000 characters, so a push can only ever be a nudge.
- The client's card parser ignores unknown fields and reads Hermes's `securitySchemes: { bearer: { type: "http", scheme: "bearer" } }` as bearer. JSON-RPC errors without `data` parse cleanly.
- Wakes: when a result arrives and the calling run is terminal, or the tick finds an unread result on a finished run, start a follow-up run in the same session with `sessionId`, the calling run's reply target, and the text labelled as a peer's answer in the envelope from AA.3. A wake counts against the hourly limit and happens once, by compare-and-set on `result_read_at`.
- `apps/web/src/server/tick/a2a.ts` with its entry in `jobs.ts`: deliver due outbox rows (backoff, 8 attempts, drop with an event), poll due outbound tasks, run wakes, retry `activating` connections, expire stale invites, and do AA.3's sweep. Bounded per tick so one tick can't run long.

## Check
- Tests with a fake peer cover, each as its own test:
  - The client against both bindings, including each credential scheme, and malformed peer responses refused.
  - Each `outbound_policy`, with the approval card showing the full text and nothing sent before the answer.
  - A retry with the same `requestId` sending once.
  - A webhook with the wrong token, a duplicate delivery, and a forged body claiming completion, which changes nothing unless `GetTask` agrees.
  - A fixture of Hermes's real card and error bodies parsing, and a client timeout recovering the task through `ListTasks`.
  - Polling to completion, and stopping at 24 hours.
  - A wake on a finished run reaching the same session with the same reply target, happening once, and no wake when `get_run` already read the result.
  - Outbox backoff and drop.
  - `safeFetch` refusing a private address and a redirect, and in-process dispatch taken for `PUBLIC_BASE_URL`.
  - `packages/a2a` still importing only zod.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-31: created.
