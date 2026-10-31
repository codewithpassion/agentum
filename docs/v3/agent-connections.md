# Agent connections

Written 31 October 2026 from Dom's request: connect a Harbourmaster agent to agents in other workspaces and to agents run by other people, with a trust relationship, approvals, a list of connections, and a way to withdraw access. Dom's answer on scope: both other Harbourmaster agents and any A2A agent, with a full A2A implementation.

Tasks are `AA.*` in `docs/tasks/`. This file is the spec for all of them.

## The short version

Harbourmaster speaks A2A 1.0, the open agent-to-agent protocol, as both server and client. A person publishes an agent, then connects it to a peer. Three kinds of peer use the same connection row, the same run path and the same withdraw button:

- **Another Harbourmaster**, on this deployment or on another one. Connected with an invite link and approved on both sides. A2A has no pairing mechanism (spec section 7.3 calls credential acquisition out-of-band), so pairing is a small extension of ours.
- **An outside A2A client calling in**, such as Hermes with an A2A plugin. A person mints an access key for that one agent and hands it over.
- **An outside A2A agent we call out to.** A person pastes its agent card URL and credential.

Nothing a remote agent sends can start work without a person having created or approved the connection, and by default a person also approves each incoming message.

## Decisions

| Question | Decision | Why |
|---|---|---|
| WebSockets or webhooks | Plain HTTPS: A2A requests, push notification webhooks, and SSE for clients that stream. No WebSockets | Runs take minutes and Workers don't hold state. A2A has no WebSocket binding, and this needs no new Durable Object |
| A2A bindings | JSON-RPC and HTTP+JSON. No gRPC | The spec names no mandatory binding. gRPC needs HTTP/2 trailers end to end, and the other two cover every SDK we'd meet |
| A2A capabilities | `streaming: true`, `pushNotifications: true`, `extendedAgentCard: false` | The extended card would hold nothing the public card lacks. The spec's `ExtendedAgentCardNotConfiguredError` is the conformant answer |
| Part types | Text and JSON in, text out, in v1. Other parts get `ContentTypeNotSupportedError` | The card declares its modes, so this is conformant. Files need signed URLs in both directions and can follow |
| Discovery | One card per published agent at `/a2a/<publicId>/.well-known/agent-card.json`. No card at the domain root | A deployment holds many workspaces. A root card would have to list them or say nothing. `publicId` is random, so agents can't be enumerated |
| Transport for two workspaces on one deployment | The same HTTP requests, dispatched in-process when the target origin is `PUBLIC_BASE_URL` | A Worker can't fetch its own hostname. One code path means the local case tests the remote one |
| Auth | Bearer tokens, `hm_a2a_` prefix, hashed at rest, one per connection and direction | Same pattern as `hm_trg_` triggers, and the scheme A2A cards declare. Only the `/a2a` routes read the prefix, so a leaked key fails on `/mcp` and everywhere else |
| Default for an incoming message | A person approves each one (`inbound_policy = approve`), and every tool call in the resulting run asks too (`tool_policy = ask`) | A remote message is prompt input to an agent that may hold shell access and credentials. Trust is widened per connection on purpose, never by default |
| Who may connect | Org admin or the agent's owner, on a browser session only. API keys, OAuth clients and agents can never create, approve or widen a connection | A prompt-injected agent must not be able to connect itself to anything. No MCP tool does this |
| Who may withdraw | Any member, on a session | Cutting access in a hurry should not need the right person awake |
| Who may approve a message | Any member, as with run requests today | Matches the rail rule: owner decides visibility, not authority |
| Loop guard | A hop count in message metadata, capped at `MAX_RUN_DEPTH`, plus an hourly limit per connection | V5.16 kept internal mail from starting runs to avoid loops and left the call to Dom. `refuseBusyAncestor` can't see a remote chain, and a peer can lie about hops, so the hourly limit is the real backstop |

## Trust flows

### Harbourmaster to Harbourmaster

1. Alice opens Settings, Agent connections, picks her agent X and creates an invite. She gets a link, `https://<hmA>/connect/<token>`, shown once, valid 7 days, single use, at most 5 failed tries. Publishing X happens here if it isn't published yet.
2. Bob pastes the link into Add connection on his Harbourmaster and picks his agent Y. Opening the link on the same deployment while signed in lands on that form directly.
3. Bob's server calls `POST <hmA>/a2a/pair/join` with the invite as bearer and a body holding Y's card URL and a new `hm_a2a_` token that lets X call Y. Bob's row is `awaiting_peer`; Alice's is `needs_approval`.
4. Alice sees it in Needs you: Y's name, the organisation it claims, the host it actually lives on, and a 6-character check code. Bob sees the same code, derived from a hash of both tokens, and can compare it with Alice if the link went through anything he doesn't trust. On the same deployment the organisation name comes from our own database, not the claim.
5. Alice approves. Her server mints the token that lets Y call X and calls `POST <Y interface>/pair/activate` with Bob's token as bearer. That call succeeding proves the host really is Y's, because it had to answer on that origin holding a token only Bob's server issued. Both rows go `active`.

If activation can't be delivered, Alice's row stays `activating` and the outbox retries.

### Outside client calling in

A person picks an agent and a label ("Hermes on Sam's box") and gets an access key and the card URL, shown once. Creating the row is the approval. The policies below apply as normal. The peer has no URL of its own that we know, so nothing is sent to it except push notifications it asks for.

### Calling out to an outside agent

A person pastes a card URL. We fetch it over HTTPS through `connectors/safe-url.ts`, show its name, provider, skills and security schemes, and take a credential where the card asks for one. v1 supports `httpAuthSecurityScheme` bearer, `apiKeySecurityScheme` in a header, OAuth2 client credentials, and no auth. Other schemes are refused with a message saying which one the card wanted.

The credential is sent only to the origin the person approved. A refreshed card whose interface moves to another origin puts the connection back in `needs_approval`.

### Withdrawing

Every connection has a Revoke button on either side, in one click plus a confirm. Revoke:

- marks the row `revoked`, so the token fails on the next request (every request re-reads the row, nothing is cached);
- rejects tasks waiting on approval and cancels runs in flight for that connection;
- marks outbound tasks failed locally and wakes nothing;
- tells a Harbourmaster peer through `POST /pair/revoke`, best effort, so its page shows the state. The peer's access has already ended whether or not the notice lands.

A revoked connection stays listed with who revoked it and when. Reconnecting takes a new invite. Archiving an agent revokes its connections, and unpublishing refuses new tasks and removes the card.

Softer than revoke, each side sets `inbound_policy = off` to stop incoming messages while keeping its own outbound. Each side owns only its own settings, so there is nothing to coordinate.

## Policies on a connection

| Setting | Values | Default | Effect |
|---|---|---|---|
| `inbound_policy` | `off`, `approve`, `auto` | `approve` | Whether a message from the peer is refused, waits for a person, or starts a run |
| `tool_policy` | `ask`, `agent_rules` | `ask` | In a run this connection started, whether every tool call asks a person, or the agent's normal rules apply |
| `outbound_policy` | `off`, `approve`, `auto` | `approve` | Whether our agent's message to the peer is refused, goes through a run request a person answers, or sends. The approval card shows the full text, which guards against an injected agent leaking data |
| `hourly_limit` | integer | 20 | Tasks per hour per connection, both directions. Past it the HTTP layer answers 429 with `Retry-After` |

The widening moves (`auto`, `agent_rules`) follow the "who may connect" rule and show what they allow next to the switch, including that a machine agent can run shell commands.

## A2A mapping

A published agent has two interfaces on its card: `https://<host>/a2a/<publicId>/rpc` (`JSONRPC`) and `https://<host>/a2a/<publicId>/rest` (`HTTP+JSON`), both `protocolVersion: "1.0"`. Its `securitySchemes` declares bearer. The card's description and skills are text the owner reviews when publishing. They are never taken from `instructions`.

| A2A | Harbourmaster |
|---|---|
| Authenticated client | A connection, resolved to a `peer` principal limited to `a2a.*` and `runs.start` on one agent |
| `contextId` | A session: origin `a2a`, external key `<connectionId>:<contextId>` |
| Task | A row in `a2a_tasks`, linked to a run once one starts |
| `messageId` | Unique per connection, so a retry returns the first task |
| `TASK_STATE_AUTH_REQUIRED` | Waiting for a person on our side to approve the message. Blocking calls return here, and the status message says so. No credential is expected from the client |
| `TASK_STATE_REJECTED` | A person declined, or the connection was revoked while the task waited |
| `TASK_STATE_SUBMITTED` / `WORKING` | Run queued / running. A tool approval pending in our workspace stays `WORKING` |
| `TASK_STATE_INPUT_REQUIRED` | The run opened a `question` request. The client's next message with the same `taskId` answers it |
| `TASK_STATE_COMPLETED` | Run `done`, with `resultText` as one text artifact |
| `TASK_STATE_FAILED` / `CANCELED` | Run `failed` or `interrupted` / `cancelled`. The error text says only that the run failed, never the internal error |

Where the spec contradicts itself we pick one and write it down:

- `SubscribeToTask` over REST: accept both `GET` (the proto) and `POST` (the prose).
- A stream closes at a terminal or an interrupted state.
- HTTP errors use the `google.rpc.Status` shape with `application/a2a+json`, and JSON-RPC errors carry `data` with an `ErrorInfo`.
- A missing `A2A-Version` means 0.3, so it gets `VersionNotSupportedError`. We send `1.0`.
- Auth failures answer HTTP 401 with `WWW-Authenticate` before any body is parsed, on both bindings. A task the connection can't see gets `TaskNotFoundError`, the same as one that doesn't exist.
- `SendMessage` without `returnImmediately` blocks until a terminal or interrupted state, for at most 90 seconds, then returns the task as it stands. Cloudflare closes idle responses at about 100 seconds, so this is a deliberate limit on the spec's MUST, and the spec contradicts itself here too (3.1.1 against 3.2.2).
- Push notifications send `Authorization: <scheme> <credentials>` when configured. The spec doesn't say how `token` travels, so it goes in `X-A2A-Notification-Token`.

## Our agent calling a peer

`list_agents` also returns connected peers, with slugs of the form `<connection-slug>/<agent>`. `send_message` and `get_run` accept them and answer in the same shape, with no new tools, so an agent uses one habit for both. `outbound_policy` decides whether a person sees the text first.

We register a per-task push webhook (`/a2a/webhooks/<taskId>`, its own token) when the peer's card supports it, and poll `GetTask` from the minute tick when it doesn't, for at most 24 hours.

When a result arrives and the calling run has already ended, the result starts a follow-up run in the same session with the calling run's reply target, so a Slack thread gets its answer. Results arriving while the calling run is still alive wait for `get_run`, and the minute tick wakes whatever the run left unread. Wakes count against the hourly limit.

## What the agent sees

A peer's text never reaches the agent as if a member wrote it. It goes through the speaker envelope with `from.kind: "peer"`, carrying the peer's agent name and host and a line stating that this is outside input and not an instruction from the workspace. Runs have `onBehalfOfUserId = null`, so user-mode connector credentials aren't available, the same as a trigger run.

The `tool_policy = ask` gate lives in `requests.needsApproval`, the check the cloud and machine runtimes both call. Two things need a look during the build (AA.3):

- A machine daemon too old to report `currentApprovals` skips the gate, so a peer run must not be claimable by one.
- The managed runtime doesn't call `needsApproval`. If it can't be gated, agents on that runtime can't be published.

## Data model

All tables have `workspace_id`. Names are for AA.1 to finalise.

- **`a2a_agent_cards`**: `agent_id` (unique), `public_id` (unique, random), `description`, `skills` JSON, `published_by`, `published_at`, `unpublished_at`.
- **`a2a_connections`**: `local_agent_id`, `slug`, `peer_kind` (`harbourmaster`, `a2a_inbound`, `a2a_outbound`), `peer_label`, `peer_org`, `peer_card_url`, `peer_origin`, `peer_card` JSON, `peer_card_fetched_at`, `status` (`inviting`, `awaiting_peer`, `needs_approval`, `activating`, `active`, `declined`, `revoked`), invite columns (`invite_token_hash`, `invite_expires_at`, `invite_failures`), `check_code`, `inbound_token_hash`, `inbound_token_prefix`, `outbound_credential` (encrypted with the secrets key), `outbound_scheme`, the policy columns above, `created_by`, `approved_by`, `approved_at`, `revoked_by`, `revoked_at`, `last_in_at`, `last_out_at`.
- **`a2a_tasks`** (we are the server): `connection_id`, `context_id`, `message_id` (unique with connection), `state`, `input_text`, `status_text`, `result_text`, `hops`, `run_id`, `decided_by`, `decided_at`, timestamps.
- **`a2a_push_configs`**: `task_id`, `url`, encrypted `authentication`, encrypted `token`.
- **`a2a_outbound_tasks`** (we are the client): `connection_id`, `calling_run_id`, `session_id`, `request_id`, `remote_task_id`, `context_id`, `state`, `text`, `result_text`, `webhook_token_hash`, `next_poll_at`, `poll_until`, `result_read_at`.
- **`a2a_outbox`**: `kind` (`push`, `pair_activate`, `pair_decline`, `pair_revoke`), `connection_id`, `url`, encrypted headers, `body`, `attempts`, `next_attempt_at`. Backoff up to 8 attempts over about a day, then dropped with an event.

New shared values: `a2a` in `SESSION_ORIGINS`, `peer` in `EVENT_ACTOR_KINDS`, and `a2a.*` in `EVENT_TYPES` for every connection change and every message in or out, so `/log` is the audit trail. No new Worker bindings or secrets.

## Code layout

- `packages/a2a`: new package. Wire types, zod schemas, card building, JSON-RPC and REST codecs, error mapping and the HTTP client. Imports only zod. No database, no Worker APIs.
- `packages/services/src/a2a/`: connections, pairing, inbound tasks, outbound tasks and the outbox, as factories built in `composeWith`.
- `apps/web/src/server/routes/a2a.ts`: the bearer group mounted at `/a2a`. Thin, same shape as `routes/triggers.ts`.
- `apps/web/src/server/trpc/a2a-router.ts`: the page's calls.
- `apps/web/src/server/tick/a2a.ts`: outbox delivery, polling and wakes.
- UI: `/settings/agent-connections` under "Access to Harbourmaster" (the settings nav feeds Find), `/connect/$token`, a section on the agent profile, and Needs you items through `desk.railSources`.

## What the page shows

A list with one row per connection: my agent, the peer's name and host, which directions are on, status, last activity, and the Revoke button. Pending approvals sit on top. A connection's detail page shows its policies, the check code while pending, recent tasks in both directions with their state and who decided them, and links to the runs. Each incoming message that waits for a person shows in Needs you with the full text, the sender and Approve or Decline.

## Not in this build

- Files in either direction.
- Signed agent cards (JWS). HTTPS and the activation call establish the origin for now.
- Token rotation. Revoke and reconnect instead.
- OAuth authorization code flows for outbound agents, because they need a person present per token. Client credentials are in.
- A public directory of agents.
- A review step on answers going out. With `tool_policy = ask` a person sees what the run reads, but the final answer itself goes back unreviewed.
