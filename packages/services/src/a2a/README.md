# Agent connections (`a2a`)

The services behind agent connections: publishing an agent, pairing it with another Harbourmaster or an outside A2A client, and the A2A tasks that move between the two sides. The spec is [`docs/v3/agent-connections.md`](../../../../docs/v3/agent-connections.md). The `/a2a` routes live in `apps/web/src/server/routes/a2a.ts`, and the page calls go through `apps/web/src/server/trpc/a2a-router.ts`.

## How it is built

Each module exports a factory that takes its dependencies as one object. `createConnectionsService({ atomic, clock, db, events, publicBaseUrl, secretsKey?, fetchCard?, transport? })` is one example. `apps/web/src/server/compose.ts` builds these factories in `composeWith` and passes them in. Nothing here reads `env`. The app passes the secrets key and the public base URL in as values.

The services do no HTTP of their own. A call that must reach a peer and answer goes through an injected transport, and a call that may be retried becomes an `a2a_outbox` row. Rows that must land together are written through `atomic`. Services keep no state on the instance, since `composeWith` may build one per request. Every race is decided by the database, usually by a compare-and-set on a state or on `result_read_at`.

Tokens are shown once and stored as SHA-256 hashes. The credential we present to a peer is sealed with the secrets key and bound to its row.

## Modules

| Module | What it owns |
| --- | --- |
| `connections.ts` | Publishing (`publish`, `unpublish`), invites and joins (`createInvite`, `join`, `approve`, `decline`), access keys (`createAccessKey`), outbound connections (`addOutbound`), policies (`setPolicies`), `revoke`, and peer authentication (`authenticate`, which turns an `ag_a2a_` or `hm_a2a_` token into a `peer` principal). |
| `pairing.ts` | Pairing by code for an outside client that has no key yet (`createPairing`). The client's request stores the hash of its token and gets an 8-character code back. The owner types the code in, and the token becomes the inbound token of a new connection. The limits follow Hermes's `gateway/pairing.py`. |
| `pairing-code.ts` | Pure Web Crypto. `randomPairingCode` and `pairingRequestCode` make the pairing codes, and `checkCode` makes the check code that both sides of an invite compare. It never touches the database. |
| `tasks.ts` | Inbound A2A tasks (`createA2aTasksService`). A peer's message becomes an `a2a_tasks` row. The inbound policy refuses it, holds it for a person, or starts a run. The module also owns approval, decline, cancel, and the `gateway` that the runs service calls with a finished run's reply. A task moves only through `move`, a compare-and-set on the state it expects. |
| `push-configs.ts` | Where a task's updates are pushed (`createPushConfigs`). A config holds a URL, a scheme and credentials. The credentials are sealed and never read back. A task holds at most `PUSH_CONFIGS_PER_TASK` configs, and a state change queues their outbox rows. |
| `outbound.ts` | Our agent calling a peer (`createOutboundService`). `send` applies the connection's outbound policy, the hourly limit and the hop count, then writes an `a2a_outbound_tasks` row keyed by request id, so a retry does not send twice. The minute tick polls `GetTask` for up to a day (`POLL_WINDOW_MS`). A webhook is only a nudge to poll at once. When a result arrives after the calling run has ended, a follow-up run carries it. |
| `outbox.ts` | Delivery of `a2a_outbox` rows (`createOutboxService`): task pushes, pairing activation, and the decline and revoke notices. A tick claims up to `OUTBOX_BATCH` rows and POSTs each through the injected fetch. A failed row backs off by `OUTBOX_BACKOFF_MS`, about 22 hours in all. The last attempt drops the row with an event that names no URL, header, token or response body. |
| `hourly.ts` | The per-connection hourly limit (`hourlyUse`, `hourlyCountSql`). It counts tasks in both directions, a peer's answers to our agent's questions (`a2a_answer_markers`) and the wakes a peer's answer started. A wake has no row, so its claim writes `result_read_at` as a time followed by `WAKE_MARK`. The count and the claim are one statement. |
| `page-reads.ts` | What the connections page reads (`createPageReads`): a connection's recent tasks in both directions, up to `RECENT_TASKS_LIMIT`, and whether the caller may change it. Reads only, and nothing here carries a token. |
| `needs-you.ts` | Types only: `WaitingMessage` and `A2aNeedsYouSource`. The desk depends on this shape and not on the services that fill it. |
| `card-peer.ts` | Reads the agent card of a peer we call out to. Pure, with no database and no fetch. `chooseOutboundScheme` picks the one auth scheme v1 can send, and `chooseInterface` picks the one interface we can call. When nothing fits, it says what it refused. |
| `task-view.ts` | `toTask` turns a task row into an A2A `Task`. The status words for each state are here too (`STATUS_TEXT`, `questionStatusText`). Pure. |
| `urls.ts` | The shapes of published and pairing URLs. `interfaceBase` gives `https://<host>/a2a/<publicId>`, `cardUrlOf` adds the card file name, and `connectLinkOf` gives the invite link. New access tokens start with `ag_a2a_` (`ACCESS_TOKEN_PREFIX`) and invites with `ag_inv_` (`INVITE_TOKEN_PREFIX`). `hm_a2a_` and `hm_inv_` tokens from before the rename are still accepted (`isInviteToken`, `connectionIdOfInvite`). |
| `errors.ts` | `A2aTaskError` carries a name from the A2A spec. `A2aRateLimitError` carries `retryAfterSeconds`, which the route sends as `Retry-After` with a 429. Anything else the module refuses is a `ServiceError` or a `ForbiddenError`. |
| `access.ts` | Who may touch a connection. `requireSession` admits only a signed-in browser session. `requireAdminOrOwner` adds the org admin or the agent's owner. `requireReader` admits anyone who may look. Every method of the connections service starts here. |
| `outbound-fixture.ts` | Test code only. It wires the real runs, requests, events and connections services, an outbound service over the same database, and a fake peer at `https://peer.test`. |
| `tasks-fixture.ts` | Test code only. It wires the services the way `composeWith` does, over `migrated()`. The cloud adapter starts no run, so a test moves each run by hand. |

## The peer principal

A connection's token resolves through `authenticate` to a `peer` principal. The principal may call `a2a.*` actions and `runs.start`, as `authz.can` enforces, and it works on the one agent the connection belongs to. Every request re-reads the connection row, and nothing is cached between requests. A revoke therefore takes effect on the next request.

`createPrincipalResolver` does not handle A2A tokens, `ag_a2a_` or `hm_a2a_`. A token is accepted only on the `/a2a` routes.

## Rules that are easy to break

Tokens work only on `/a2a`. A leaked key fails on `/mcp` and every other route.

No MCP tool may create, approve, widen or revoke a connection.

Only an org admin or the agent's owner, on a browser session, may connect, approve or widen. API keys, connected apps, runs, machines, triggers and peers are refused, so a prompt-injected agent cannot connect itself to anything.

Any member may revoke a connection. Any member may approve or decline a waiting message, as with run requests.

Peer text is outside input. `buildPeerEnvelope` in `packages/services/src/speaker-envelope.ts` wraps it with `from.kind` set to `peer`, the peer's agent name and host, and a line that says it is not an instruction from the workspace. Peer text never reaches an agent as if a member wrote it.

`allowLoopback` lets a peer live on localhost over plain HTTP. `composeWith` sets it from `devFakeRuntime`, which is on in dev builds only. A production build refuses plain HTTP and loopback addresses for a peer.

A credential goes only to the origin a person approved. A refreshed card that moves the interface to another origin puts the connection back in `needs_approval`.

## Tests

From `packages/services`, run `bun test src/a2a`. The package has no `bunfig.toml`, so a bare `bun test` works here. The connection and pairing tests use `migrated()` for a real database. The outbound and task tests use the fixtures above.
