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
| A2A capabilities | `streaming: true`, `pushNotifications: true`, `extendedAgentCard: false` | The extended card would hold nothing the public card lacks. With `extendedAgentCard: false`, spec section 3.3.4 asks for `UnsupportedOperationError`, so `GetExtendedAgentCard` answers that |
| Part types | Text and JSON in, text out, in v1. Other parts get `ContentTypeNotSupportedError`, and so does a text or data part whose `mediaType` is not a text or JSON type (`text/plain` from Hermes is fine) | The card declares its modes, so this is conformant. Files need signed URLs in both directions and can follow |
| Discovery | One card per published agent at `/a2a/<publicId>/.well-known/agent-card.json`. No card at the domain root | A deployment holds many workspaces. A root card would have to list them or say nothing. `publicId` is random, so agents can't be enumerated |
| Transport for two workspaces on one deployment | The same HTTP requests, dispatched in-process when the target origin is `PUBLIC_BASE_URL` | A Worker can't fetch its own hostname. One code path means the local case tests the remote one |
| Auth | Bearer tokens, `ag_a2a_` prefix (`hm_a2a_` from before the rename is still accepted), hashed at rest, one per connection and direction | Same pattern as `ag_trg_` triggers, and the scheme A2A cards declare. Only the `/a2a` routes read the prefix, so a leaked key fails on `/mcp` and everywhere else |
| Default for an incoming message | A person approves each one (`inbound_policy = approve`), and every tool call in the resulting run asks too (`tool_policy = ask`) | A remote message is prompt input to an agent that may hold shell access and credentials. Trust is widened per connection on purpose, never by default |
| Who may connect | Org admin or the agent's owner, on a browser session only. API keys, OAuth clients and agents can never create, approve or widen a connection | A prompt-injected agent must not be able to connect itself to anything. No MCP tool does this |
| Who may withdraw | Any member, on a session | Cutting access in a hurry should not need the right person awake |
| Who may approve a message | Any member, as with run requests today | Matches the rail rule: owner decides visibility, not authority |
| Loop guard | A hop count in message metadata, capped at `MAX_RUN_DEPTH`, plus an hourly limit per connection | V5.16 kept internal mail from starting runs to avoid loops and left the call to Dom. `refuseBusyAncestor` can't see a remote chain, and a peer can lie about hops, so the hourly limit is the real backstop |

## Trust flows

### Harbourmaster to Harbourmaster

1. Alice opens Settings, Agent connections, picks her agent X and creates an invite. She gets a link, `https://<hmA>/connect/<token>`, shown once, valid 7 days, single use, at most 5 failed tries. Publishing X happens here if it isn't published yet.
2. Bob pastes the link into Add connection on his Harbourmaster and picks his agent Y. Opening the link on the same deployment while signed in lands on that form directly.
3. Bob's server calls `POST <hmA>/a2a/pair/join` with the invite as bearer and a body holding Y's card URL and a new `ag_a2a_` token that lets X call Y. Bob's row is `awaiting_peer`; Alice's is `needs_approval`.
4. Alice sees it in Needs you: Y's name, the organisation it claims, the host it actually lives on, and an 8-character check code, from the same alphabet as the pairing code below. Bob sees the same code, derived from a hash of both tokens, and can compare it with Alice if the link went through anything he doesn't trust. On the same deployment the organisation name comes from our own database, not the claim.
5. Alice approves. Her server mints the token that lets Y call X and calls `POST <Y interface>/pair/activate` with Bob's token as bearer. That call succeeding proves the host really is Y's, because it had to answer on that origin holding a token only Bob's server issued. Both rows go `active`.

If activation can't be delivered, Alice's row stays `activating` and the outbox retries.

### Outside client calling in

A person picks an agent and a label ("Hermes on Sam's box") and gets an access key and the card URL, shown once. Creating the row is the approval. The policies below apply as normal. The peer has no URL of its own that we know, so nothing is sent to it except push notifications it asks for.

### Pairing code, for an outside client we haven't given a key

Hermes's own pairing approves people on chat platforms: an unknown sender gets a one-time code in reply, and the owner approves that code from the CLI. Its A2A platform doesn't use it. A2A peers there need a token and a place in `A2A_TRUSTED_PEERS`, so there is no pairing protocol to be wire-compatible with. This flow gives a Hermes agent the same experience against us, using only what `a2a_call` already does, and it copies Hermes's limits.

It is off unless an admin or the agent's owner turns on "Accept pairing requests" for that agent.

1. The Hermes operator makes up a long random token (at least 32 characters), sets it as `auth.token` for our agent in `a2a_agents`, and calls the agent.
2. We don't recognise the token. With pairing on, `SendMessage` answers HTTP 200 with a `TASK_STATE_REJECTED` task whose status message holds an 8-character code and says nothing was delivered. A 401 wouldn't work, because Hermes replaces a 401's body with a generic auth error, while it reads `status.message` as the reply. The message text isn't stored. Every other operation still answers 401.
3. The peer passes the code to our owner by their own means. The owner types it into the page and gives the connection a label. There is no approve button and no Needs you card, on purpose: only someone the owner actually heard from can get in, so a stranger's request can't be clicked through by mistake.
4. The request's token hash becomes the connection's inbound token. The peer's next call works, under the default policies.

Limits, from Hermes's `gateway/pairing.py`: 8 characters from an alphabet without `0`, `O`, `1` or `I`, hashed at rest, 1 hour expiry, at most 3 pending per agent, the same token gets its existing code back, lockout for 1 hour after 5 wrong codes, and codes never logged. With pairing off, or a token under 32 characters, the request gets the normal 401. Answering 200 to an unauthenticated caller bends the spec's "authenticate every request", which is why it is opt-in and per agent, and why it creates no task and starts no work.

### Calling out to an outside agent

A person pastes a card URL. We fetch it over HTTPS through `connectors/safe-url.ts`, show its name, provider, skills and security schemes, and take a credential where the card asks for one. v1 supports `httpAuthSecurityScheme` bearer, `apiKeySecurityScheme` in a header, OAuth2 client credentials, and no auth. Other schemes are refused with a message saying which one the card wanted.

The credential is sent only to the origin the person approved. A refreshed card whose interface moves to another origin puts the connection back in `needs_approval`.

### Withdrawing

Every connection has a Revoke button on either side, in one click plus a confirm. Revoke:

- marks the row `revoked`, so the token fails on the next request (every request re-reads the row, nothing is cached);
- rejects tasks waiting on approval and cancels every live run whose chain reaches that connection: its task runs, the runs they handed work to (a hand-off outlives its parent's end), and wakes carrying its answers;
- marks outbound tasks failed locally and wakes nothing;
- tells a Harbourmaster peer through `POST /pair/revoke`, best effort, so its page shows the state. The peer's access has already ended whether or not the notice lands.

A revoked connection stays listed with who revoked it and when. Reconnecting takes a new invite. Archiving an agent revokes its connections, and unpublishing refuses new tasks and removes the card.

Softer than revoke, each side sets `inbound_policy = off` to stop incoming messages while keeping its own outbound. Each side owns only its own settings, so there is nothing to coordinate.

## Policies on a connection

| Setting | Values | Default | Effect |
|---|---|---|---|
| `inbound_policy` | `off`, `approve`, `auto` | `approve` | Whether a message from the peer is refused, waits for a person, or starts a run |
| `tool_policy` | `ask`, `agent_rules` | `ask` | In a run this connection started, a run it handed work to, or a wake carrying its answer, whether every tool call asks a person, or the agent's normal rules apply. In a chain with several connections, any one at `ask` (or ended) makes the run ask |
| `outbound_policy` | `off`, `approve`, `auto` | `approve` | Whether our agent's message to the peer is refused, goes through a run request a person answers, or sends. The approval card shows the full text, which guards against an injected agent leaking data |
| `hourly_limit` | integer | 20 | Per connection, over the last hour: tasks the peer sent us, tasks our agent sent it, the peer's answers to our agent's questions, and the wakes a peer's answer started. Answers our agent or a member gives don't count. Past it the HTTP layer answers 429 with `Retry-After`. An answer that would pass it is refused and leaves the question open |

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
| `TASK_STATE_INPUT_REQUIRED` | The run opened a `question` request. The client's next message with the same `taskId` answers it. A question lasts 1 hour in any run whose chain reaches a peer (a run a peer started, a hand-off from one, or a wake carrying its answer), even when a member's own outbound conversation is the one waiting. Then the run is cancelled so it cannot ask again, and a task waiting on it ends in `TASK_STATE_FAILED` with a status message saying so. Only a run no peer set going keeps 24 hours |
| `TASK_STATE_COMPLETED` | Run `done`, with `resultText` as one text artifact |
| `TASK_STATE_FAILED` / `CANCELED` | Run `failed` or `interrupted` / `cancelled`. The error text says only that the run failed, never the internal error |

Where the spec contradicts itself we pick one and write it down:

- `SubscribeToTask` over REST: accept both `GET` (the proto) and `POST` (the prose).
- A `SendStreamingMessage` stream closes at a terminal or an interrupted state (section 11.7). A `SubscribeToTask` stream closes only at a terminal state (section 3.1.6), so a client can subscribe to a task that waits for input and watch it move on once answered.
- Both bindings answer `application/json` (sections 9.1 and 11.1). The examples in section 6 show `application/a2a+json`, and the official TCK checks `application/json`.
- HTTP errors use the `google.rpc.Status` shape, and JSON-RPC errors carry `data` with an `ErrorInfo`. The status codes are those of section 5.4 of the v1.0.0 spec: 404 for `TaskNotFoundError`, 409 for `TaskNotCancelableError`, 415 for `ContentTypeNotSupportedError`, 502 for `InvalidAgentResponseError` and 400 for the rest.
- ProtoJSON allows a field under its proto name, so `task_id` is read as `taskId` in a request. The contents of `metadata` and `data` parts are left alone.
- JSON-RPC answers at the card's `.../rpc` and at `.../rpc/`, because `httpx` joins a `/` onto the URL it is given.
- `DeleteTaskPushNotificationConfig` is idempotent (section 3.1.10): deleting a config that is gone answers success.
- A repeated `messageId` returns the first task, which spec 3.3.1 allows ("MAY be idempotent").
- A missing `A2A-Version` means 0.3, so it gets `VersionNotSupportedError`. We send `1.0`.
- Auth failures answer HTTP 401 with `WWW-Authenticate` before any body is parsed, on both bindings. A task the connection can't see gets `TaskNotFoundError`, the same as one that doesn't exist.
- `SendMessage` without `returnImmediately` blocks until a terminal or interrupted state, for at most 90 seconds, then returns the task as it stands. Cloudflare closes idle responses at about 100 seconds, so this is a deliberate limit on the spec's MUST, and the spec contradicts itself here too (3.1.1 against 3.2.2).
- Push notifications send `Authorization: <scheme> <credentials>` when configured. The spec doesn't say how `token` travels, so it goes in `X-A2A-Notification-Token`. A push goes out as soon as its task changes, and the minute tick retries what failed.

## Our agent calling a peer

`list_agents` also returns connected peers, with slugs of the form `<connection-slug>/<agent>`. `send_message` and `get_run` accept them and answer in the same shape, with no new tools, so an agent uses one habit for both. `outbound_policy` decides whether a person sees the text first.

We register a per-task push webhook (`/a2a/webhooks/<taskId>/<token>`) when the peer's card supports it, and poll `GetTask` from the minute tick either way, for at most 24 hours, because a push may never come. A push is only a nudge to call `GetTask` straight away. Its body is never trusted (see "Hermes compatibility").

When a result arrives and the calling run has already ended, the result starts a follow-up run in the same session with the calling run's reply target, so a Slack thread gets its answer. Results arriving while the calling run is still alive wait for `get_run`, and the minute tick wakes whatever the run left unread. Wakes count against the hourly limit.

A wake carries a peer's text with nobody watching, so it is held to the same rules as a run the peer started. Its actor is that peer's connection and `onBehalfOfUserId` is null, as for a trigger run, so the person's user-mode connector credentials and file attachments never reach it. It keeps the calling run's parent and depth, `tool_policy` gates it (a wake on an `agent_rules` connection under a run that started on an `ask` connection still asks, because every link in the chain counts), and a machine daemon without `currentApprovals` can't claim it. A wake on a managed agent is refused, and the answer is never read by that agent (a run of a managed agent can't use `get_run` either). A question a wake asks is for the session's members, and no peer can answer it. It lasts 1 hour like any question in a run whose chain reaches a peer (see the `TASK_STATE_INPUT_REQUIRED` row).

## Hermes compatibility

Hermes is the first outside peer we must work with. It ships native A2A 1.0 in `plugins/platforms/a2a` (since v0.20, latest v0.22.5, read 1 November 2026), so a connection needs no plugin on its side. It speaks JSON-RPC only, uses bearer tokens, and has no invite flow, so it connects through "Give it a key" and "Call it". We follow the spec, and accept these habits of Hermes without loosening anything else.

Hermes calling us:

- It finds the card at `<base>/.well-known/agent-card.json`, so its `url` is `https://<host>/a2a/<publicId>`. Config goes in `a2a_agents` in `~/.hermes/config.yaml`, with `auth: { type: bearer, token }`. The key dialog shows this block ready to paste.
- Text parts arrive as `{ "text": ..., "mediaType": "text/plain" }`. `mediaType` is a legal `Part` field, so a text part with it counts as text. Hermes issue #127707 records strict servers refusing this, and we must not be one.
- It picks its own `contextId` on the first message. We accept client context ids.
- `a2a_call` sends one blocking `SendMessage` with a 120 second default timeout and reads the reply from the first artifact, then from `status.message`. It doesn't poll or register a push, so a task returned unfinished never delivers its answer to that call. Every unfinished task we return therefore carries a `status.message` saying in plain words what it is waiting for. Accept-then-poll is an open Hermes PR (#141947).
- Consequence for the default: at `inbound_policy = approve`, a Hermes agent gets "waiting for approval" and doesn't get the later answer by itself, though the answer stays in the session for its next message in that context. We keep `approve` as the default anyway, because safety beats convenience here. The page says this on a key connection, and a person who trusts the peer can choose `auto`. Tool approvals under `tool_policy = ask` can outlast the call in the same way.

Us calling Hermes:

- Its card declares `securitySchemes: { bearer: { type: "http", scheme: "bearer" } }` and `security`, not the proto's `httpAuthSecurityScheme` and `securityRequirements`, and it has extra fields (`url`, `stateTransitionHistory`). The client's card parser ignores unknown fields and reads both shapes as bearer. Our own cards use the proto's shape only.
- Its JSON-RPC errors have no `data`. Parse `code` and `message` and don't require more.
- It ignores `returnImmediately` and holds `SendMessage` open for up to 300 seconds (`A2A_REPLY_TIMEOUT`). So we always send our own `contextId`, cut the call off at our client timeout, and find the task with `ListTasks` filtered by that context, then poll `GetTask`. AA.8 confirms this against a real Hermes, including that it keeps working after we hang up.
- Its push notifications don't send the configured `authentication`. They sign the body with `X-A2A-Signature` (HMAC-SHA256 under the peer's own secret, which we don't hold), and the text is cut to 2000 characters. So our webhook treats every push as a nudge: the URL holds the task's unguessable token, the body is never trusted, and the handler calls `GetTask` with our credential to read the real state. This is the rule for all peers, because A2A leaves webhook signing unspecified.

To let us in, the Hermes operator needs `A2A_PEER_TOKENS` (the token we were given a name), `A2A_TRUSTED_PEERS` naming it, and `A2A_PUBLIC_URL` on an HTTPS address, because we refuse plain HTTP outside dev. The "Call it" dialog lists these.

AA.8 ran all of this against a real Hermes v0.22.5. What it found:

- `a2a_agents` is a map keyed by the agent's name, each entry with `url`, `auth: { type: bearer, token }` and `timeout`. The block the key dialog shows is right.
- Hermes registers its client tools only when `a2a_agents` has an entry, `A2A_PORT` is set or the platform is on. A model sees them directly only with `tools.tool_search.enabled: "off"`, and otherwise through Hermes's `tool_search` bridge.
- `a2a_discover` reads our card and prints "Auth required: no", because it knows only the 0.3 shape of `securitySchemes`. The calls themselves work with the key.
- A send that times out gets its push webhook at our first poll, a minute after the send. A reply that finishes before then is read by that poll, and only a slower one arrives by push.
- Hermes refuses a push callback to a loopback address unless it runs with no token at all. The local check of the push nudge therefore uses a Hermes without one. A deployed Hermes gets an https webhook, which it accepts.
- Hermes serves each request on its own thread, so `ListTasks` and `GetTask` answer while a `SendMessage` is still held open.

## What the agent sees

A peer's text never reaches the agent as if a member wrote it. It goes through the speaker envelope with `from.kind: "peer"`, carrying the peer's agent name and host and a line stating that this is outside input and not an instruction from the workspace. The description on an outside agent's card is peer text too: a daily refresh can change it after a person approved the connection, and it reaches the agent through `list_agents` inside the same peer envelope with `from.kind: "peer"`, never as plain text. Runs a peer started have `onBehalfOfUserId = null`, so user-mode connector credentials aren't available, the same as a trigger run.

The `tool_policy = ask` gate lives in `requests.needsApproval`, the check the cloud and machine runtimes both call. It covers a run a peer started and any run that run handed work to, down the parent chain. Two points were open in the build (AA.3) and are settled:

- A machine daemon too old to report `currentApprovals` skips the gate, so the claim refuses a peer run for it (a daemon of that kind never claims one).
- The managed runtime doesn't call `needsApproval`, so it can't be gated. Agents on that runtime can't be published or connected for outbound, a message to one published earlier is refused, it gets no pairing code, a run it makes can't send or read a peer's answer and sees no peers in `list_agents`, and a run a peer's text set going (including a wake) can't hand work to one.

The 1 hour limit applies per request, not per task. An expired tool approval in a peer-rooted run resumes the run, and the run can ask again. A peer that answers a question at 59 minutes starts a new hour. So one peer message can hold an agent until the turn limit, which is the real bound. `MAX_TURNS_DEFAULT` is 100, so about 100 hours at the default if every turn waits the full hour. The most a run can set is 500. The request shows in Needs you, and any member can cancel the run or revoke the connection in one click. An `auto` peer belongs on an agent that does nothing else.

Every tool call on the cloud runtime goes through the one gate, and on the machine runtime through the daemon's check once `currentApprovals` is on. The platform `/mcp` and `/api/proxy` routes take a run token without asking `needsApproval` themselves. The token reaches only the runtime, so the runtime's gate is the control, and a server-side guard for peer runs is a possible later addition.

A message from outside has no business asking a person to take over a computer, so a run whose chain reaches a peer can't. `requests.open` refuses the takeover request, whichever runtime asks, and `request_human_takeover` answers with the refusal while the run carries on.

## Data model

All tables have `workspace_id`. Names are for AA.1 to finalise.

- **`a2a_agent_cards`**: `agent_id` (unique), `public_id` (unique, random), `description`, `skills` JSON, `pairing_open` (default false), `pairing_failures`, `pairing_locked_until`, `published_by`, `published_at`, `unpublished_at`.
- **`a2a_pairing_requests`**: `agent_id`, `code_hash`, `token_hash` (unique with agent), `token_prefix`, `expires_at`, `created_at`.
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

- A second lane. An agent runs one run at a time, so peer work queues with everything else the agent does (members, Slack, triggers), and a peer's task waiting on a question holds the agent for up to an hour per question (see "What the agent sees" for the real bound). An `auto` peer belongs on an agent that does nothing else. The official TCK leaves tasks in `input_required` behind, and its script cancels them as a person would.
- Files in either direction.
- Signed agent cards (JWS). HTTPS and the activation call establish the origin for now.
- Token rotation. Revoke and reconnect instead.
- OAuth authorization code flows for outbound agents, because they need a person present per token. Client credentials are in.
- A public directory of agents.
- A review step on answers going out. With `tool_policy = ask` a person sees what the run reads, but the final answer itself goes back unreviewed.
