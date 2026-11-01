# AA.8 review record

Interop with the official A2A SDK and TCK, a real Hermes, two deployments, docs. Branch `task/AA.8-interop-and-e2e`.

## Verdicts

- Round 1, at d00826e9: not clean, 4 must-fix. The TCK summary counted "not tested" requirements as skipped and the record called the 21 not-tested MUST ones gRPC only. Hermes, the TCK and the SDK sample agent got the runner's whole shell environment. Fixed in e80cafdd, with an allowlist (`thirdPartyEnv`), a `notTested` count, an itemised record, loopback binds, a pinned TCK commit, a checked Hermes tag and stricter wake checks in the two-deployments script (they had first passed on the sending run).
- Round 2, at e80cafdd: not clean, 1 must-fix. The record said two dedicated TCK checks for `ContentTypeNotSupportedError` passed, but both skipped, because the server accepts a wrong HTTP `Content-Type`. Fixed in 90ec2a8f, with a left-open line for it.
- Round 3, at 90ec2a8f: not clean, 1 must-fix. A sentence added in round 2 said a different TCK setup would test the 25 not-tested requirements, and the TCK has no test for them. Reworded in the head commit of this branch. That change got no review round of its own, because two fix rounds were already used.

`bun run check`, `bun run test` and `bun run build` pass at e80cafdd with no `drizzle` in `apps/web/dist/client`. The later commits touch only scripts and the record, and `bun run check` and the script tests pass at each.

## What ran

Every result here comes from code we did not write (the SDK, the TCK, Hermes) running against our server, except the two-deployments script, which is our server on both sides. All of it runs in a real `vite dev` Worker (workerd, D1, Durable Objects) with the dev-only `faux` model, so no model key was used. Every step a person takes went through the real tRPC routes, signed in as the dev user through a Clerk session made with the backend API of the dev instance. Nothing was stubbed in the server. Three outputs were read straight from the database, read only: the text of an outbound task, the runs of an agent and the state of a task. The SDK, Hermes and two-deployments scripts exit 0 from the repo root. The TCK driver exits with the TCK's own code, which is 1 because of the failures listed below.

| Script | Result |
|---|---|
| `scripts/e2e/a2a-interop.ts` | 22 of 22 checks passed |
| `scripts/e2e/a2a-hermes.ts` | 8 of 8 checks passed |
| `scripts/e2e/a2a-two-deployments.ts` | 6 of 6 checks passed |
| `scripts/e2e/a2a-tck.ts` | 87 requirements passed, 4 failed, 13 skipped and 25 not tested, of 129 (see below) |

### The official SDK

`@a2a-js/sdk` 1.3.0, pinned in the root `devDependencies`. It implements A2A 1.0.0 (its README says so, and its client sent `A2A-Version: 1.0`), so no older version was needed and there is nothing to carry over to the TCK for the parts the SDK could not do.

The SDK was the client for both bindings, JSON-RPC and HTTP+JSON, 10 checks each: fetch the card, send and block, block at input-required and answer, stream, resubscribe to a running task, get with history, list by context, cancel, create, get, list and delete a push config, and a real push delivery to a local receiver (with the `Authorization` and `X-A2A-Notification-Token` headers). In the other direction the script clones the SDK at tag v1.3.0, installs it with npm in its own folder, runs its unmodified `sample-agent` on the port its card names (41241), connects one of our agents to it through "Call it", and has a run of that agent send it a message with the `send_message` tool. The sample agent's reply came back through the connection. Those two checks are the last two of the 22.

### The official TCK

`a2aproject/a2a-tck` at `main`, commit d4d6fae7 (22 October 2026). The repo has no release after `1.0.0.alpha3`, and its `pyproject.toml` says 1.0.0. Both bindings the card declares were run (`jsonrpc`, `http_json`). gRPC is not declared on our card, so its cases are skipped or not tested, and none counts.

The TCK ran unmodified, at the pinned commit above, with only the shell's basic environment variables and none of the keys in the runner's shell. Three things stand between it and our server, all in `scripts/e2e/a2a-tck-proxy.ts` and `a2a-tck.ts`, and all of them are about the TCK's assumptions, not about the protocol:

- The TCK's clients send no `Authorization` header and our server answers 401 to every call but the card. A proxy adds the key of an access key connection (inbound `auto`, hourly limit 10,000) and points the card's interface URLs at itself. The server has no unauthenticated mode.
- The TCK's scenarios say what the agent under test does for a message id prefix (`tck-input-required` waits for input). A Harbourmaster agent follows its prompt, so the proxy rewrites the text part of a message to a `faux` command (`ask ...` for input-required, `say ...` for fixed text, see `a2a-tck-prompts.ts`). Nothing else in a request is changed except the message id.
- The TCK sends one message id for every test that needs a task. Our server returns the first task for a repeated message id, which spec 3.3.1 allows, so the proxy gives each send an id of its own. The driver also cancels tasks left waiting for input once a send has been queued behind them for 6 seconds, because an agent runs one run at a time (see "Found, not fixed"). In the final run it cancelled 6.

Per requirement level, final run: MUST 79 passed, 3 failed, 11 skipped, 21 not tested; SHOULD 5 passed, 2 skipped, 4 not tested; MAY 3 passed, 1 failed. A "not tested" requirement has no verdict in the TCK's report at all, so nothing here says whether it holds. The 21 MUST ones are card signing (CARD-SIGN-001 to 004), TLS (AUTH-TLS-001), server and in-task authentication (AUTH-SERVER-002, AUTH-INTASK-001 to 004), scopes (AUTH-SCOPE-001 to 003), version negotiation on the client and server (VER-CLIENT-001 and 002, VER-SERVER-001), the equivalence of bindings (BIND-EQUIV-001 to 004) and one gRPC case (GRPC-SVC-003). The 4 SHOULD ones are AUTH-TLS-002, AUTH-SERVER-001 and AUTH-INTASK-005 and 006. The TCK has no automated test for any of the 25 at this commit: they carry no operation to call, and seven are tagged `not-automatable` by the TCK itself (card signing, TLS and AUTH-SERVER-001). No setup would give them a verdict. Signed cards are not in this build in any case. The 11 MUST skips are the other gRPC cases (6), the extended card (CARD-EXT-001 and 002), and CORE-CAP-001, 002 and 004, which need a server without push notifications (001), without streaming (002) and a required extension the card declares (004). The 2 SHOULD skips are CORE-HIST-005 and 006, two history cases that leave a task waiting for input and send it two follow-ups. Ours takes the first follow-up as the answer, the run ends, and the second is told the task has ended. That is how a question works here, not a protocol failure.

What the TCK found and this task fixed, all in a mandatory category:

- REST bodies and errors were `application/a2a+json`. Spec 9.1 and 11.1 say `application/json`, and the TCK checks it. Both bindings now answer `application/json`.
- The error table did not match section 5.4 of the v1.0.0 spec: `TaskNotCancelableError` is 409, `ContentTypeNotSupportedError` 415, `InvalidAgentResponseError` 502, and three errors map to gRPC `UNIMPLEMENTED`.
- `GetExtendedAgentCard` answered `ExtendedAgentCardNotConfiguredError`. With `extendedAgentCard: false`, section 3.3.4 says `UnsupportedOperationError`.
- JSON-RPC answered 404 at `.../rpc/`. `httpx` joins a `/` onto the interface URL, so the TCK and every Python client reach it that way. Both spellings are served.
- The TCK sends proto field names (`task_id`) on JSON-RPC. ProtoJSON allows both spellings, so `acceptProtoNames` renames them, and leaves `metadata` and `data` contents alone.
- `DeleteTaskPushNotificationConfig` of a config that is gone answered not found. Section 3.1.10 says it MUST be idempotent.
- `SubscribeToTask` on a task waiting for input closed at once with that state. Section 3.1.6 says the stream ends at a terminal state, so it now stays open through `input_required`. A `SendStreamingMessage` stream still closes at an interrupted state, as section 11.7 says.
- Push notifications went out only when the minute tick ran, so a client waited up to a minute for a state change it had asked to hear about. A state change that queues pushes now starts their delivery at once (`onPushQueued`, deferred), and the tick retries what failed. The TCK's three delivery requirements (PUSH-DELIVER-001 to 003) pass without any tick, where the app can defer the work. A composition with no `waitUntil` (the managed poller, the scheduled and email handlers) waits for the tick as before.

Left open, one line each, for Dom to decide:

- DM-ART-001 (MUST), six failures: the TCK asks the agent for a file artifact, a file URL artifact and a data artifact. Files are not in this build (the design says so), and an agent's answer is one text artifact. The text artifact case passes.
- DM-MSG-001 (MUST), two failures: the TCK asks for a `Message` as the reply to `SendMessage`. Every reply of ours is a `Task`, which the spec allows, but the TCK can only check a server that chooses to answer with a message.
- CORE-SEND-003 (MUST), two failures: this requirement has no `expected_error` in the TCK, so its generic runner expects the send to succeed and fails for any server that answers `ContentTypeNotSupportedError`, which is what the requirement text asks for. The failure message itself shows our answer (HTTP 415 on REST, "Only text and JSON parts are supported."), and our route tests check -32005 on JSON-RPC and 415 on REST for a `raw` and a `url` part. The TCK has two dedicated checks of the same error, and both skipped (see the next line), so the TCK did not confirm it. Worth a report to the TCK repo.
- Wrong HTTP `Content-Type` (two TCK checks skipped, not failed): the TCK posts a send with `Content-Type: text/plain` and expects 415 on REST. The JSON-RPC check wants a `ContentTypeNotSupportedError` body. Both bindings accept the request, because only the response sets the header and the body is read as JSON whatever it is called. Strictness would be a check in each binding, with a different answer for each, at the cost of refusing a client that forgets the header. Left for Dom.
- CARD-CACHE-003 (MAY), one failure: no `Last-Modified` on the card. The card is built from the live agent name and the skills the owner published, so there is no reliable modified time. The `ETag` and `Cache-Control` headers are there and `If-None-Match` works.

### Hermes

A real Hermes v0.22.5, the latest release tag, cloned into `<work-dir>/hermes-agent`, installed there with `uv sync --frozen` on Python 3.14.10 (the uv 0.8 on this machine could not read Hermes's lock file, so the script needs uv 0.13 or newer), with its own `HERMES_HOME` and `HOME` per instance so nothing under `~/.hermes` is read. It talks only to a fake OpenAI-compatible endpoint (`a2a-fake-openai.ts`) that answers `tool_calls` and text, streamed or not, so no key and no spend. Nothing was driven through `adapter.py` or `tools.py` directly: both halves ran the real gateway.

Hermes calls us. A real Hermes agent loop (`hermes chat`, run in the gateway daemon) is told by the fake model to call `a2a_discover` and `a2a_call` on one of our published agents:

- `a2a_discover` read the card (the script asserts its name and the JSON-RPC interface).
- `a2a_call` with an `auto` key: the answer came back, state completed.
- `a2a_call` with an `approve` key: the waiting message came back, state auth-required.
- Pairing, with "Accept pairing requests" on and a made-up 70 character token: the first call returned the 8 character code as its reply. After `a2a.approvePairingCode` the next call was let through and held for approval by the default policy.

We call Hermes. A real `hermes gateway run` with the `a2a` platform on, `A2A_PEER_TOKENS` and `A2A_TRUSTED_PEERS` set, and one of our agents connected to it through "Call it":

- A message sent by a run's `send_message` tool got Hermes's agent's reply.
- A reply that outlasts our 15 second client timeout (the fake model waits 27 seconds and answers 3000 characters): the call to Hermes ran past our client timeout, and 80 seconds after the send the minute tick's poll had stored all 3000 characters from `ListTasks` by our context and `GetTask`. Hermes kept working after we hung up. The script asserts the stored text, not the timeout itself.
- A push nudge past 2000 characters: the fake model waits 90 seconds. Our first poll, a minute after the send, found the task still working and registered the webhook. No tick ran after that. Hermes finished, pushed (its body cuts the text at 2000), and the task row held all 3000 characters, read through `GetTask` after the nudge. This check uses a second Hermes gateway with no token, because Hermes refuses a push to a loopback address unless it runs without one (its SSRF guard). A Hermes with a token that is pushed to over https was not run. Its acceptance is read from `security.py`.

What this changed in the spec: `docs/v3/agent-connections.md` now says that the `a2a_agents` YAML shape is right (a map keyed by the agent's name, as the AA.7 key dialog shows it), that Hermes registers its client tools only when it has a peer configured, and that `a2a_discover` prints "Auth required: no" for our card because it knows only the 0.3 shape of `securitySchemes` (the calls work).

### Two deployments

Two `vite dev` Workers on separate ports and `.wrangler` state (`HM_STATE_DIR`, read by `apps/web/vite.config.ts`, with no inspector port so several start at once), so two databases, two Durable Object sets and a real request between them. Plain http to localhost is allowed in dev builds only: `allowLoopback` in the connections and push config services and `allowHttp` in `createPeerFetch` all come from `devFakeRuntime`. Tests cover the refusal in production: `a2a-transport.test.ts` (a production fetch never reaches the network for `http://localhost` or `127.0.0.1`, a dev one reaches localhost and still refuses `10.0.0.1`), `compose-a2a.test.ts` (a production composition refuses "Call it" to `http://localhost`, a dev one takes it) and `safe-url.test.ts`.

The six checks: A invites and B joins over HTTP with the same check code on both sides; A approves and the activation reaches B through A's outbox, both rows active; A messages B, B holds it for approval, a person on B approves, B's agent answers, and A's ended run is woken with the answer (the wake); B messages A through the outbound approval card, A takes it, and B is woken the same way; A revokes, A's key stops working at once (B's next message gets no answer and starts no run on A, before A's notice reaches B) and B's row shows revoked once A's outbox delivers the notice; A's agent cannot send to B either.

## Fixes beyond the TCK ones above

- The two deployment checks for a woken agent first passed on the run that sent the message, because its tool call names the same text. They now look for the peer's envelope.
- `scripts/dev/local.ts` takes a state folder, so scripts can open a second database.
- The faux model reads the text inside a `harbourmaster_turn` envelope for its commands, and has `say <text>`, so a message from a peer can drive it.
- The AA.7 scratch Clerk user `aa7-second-workspace@example.com` and organisation "AA7 Second Workspace" were deleted from the dev instance.

## Found, not fixed

- An agent runs one run at a time (the claim refuses a run while another run of the agent is `running` or `waiting`). A peer that sends a message which makes the agent ask a question holds the agent for every other peer and person until the question is answered or cancelled, and a task waiting for input has no expiry that frees the agent sooner. This is the existing run model, not an AA change, and a published agent makes it reachable from outside. Dom may want a limit, an expiry or a separate session lane.
- Our server returns the first task for a repeated `messageId`. The TCK reuses one id per scenario and cannot run against that without the proxy's rewrite. Other servers do not do this, so a client that reuses ids may be surprised, though spec 3.3.1 allows it.
- The first poll of a task whose send timed out comes a minute after the send (`FAST_POLL_MS`). A reply that finishes before then is read by the poll and not by the push, and nothing registers the webhook sooner.

## Nits left

- The scripts keep their own checkouts and installs under the work folder (`/tmp/harbourmaster-a2a-e2e` by default). Nothing deletes them.
- Each script's person signs in with a new Clerk session of the dev user and revokes it on exit. A script killed in the middle leaves its session in the dev instance.
- `a2a-tck.ts`'s reaper cancels every task that waits for input once a send has queued 6 seconds, so a TCK case that keeps such a task across a long wait could be cut short. The final run's failures and skips give no sign of one, but the driver logs only how many it cancelled (6), not which.
- `scripts/e2e/a2a-tck-proxy.ts` counts message ids with a module-level counter.
- A task change that queues pushes runs a whole delivery pass (`deliverDue`, up to 50 rows of any workspace) in the request's `waitUntil`. Delivering only the rows just queued would keep one request from doing other tenants' work, and two passes at once can send a later state's push before an earlier one.
- The scripts' dev Workers get the whole shell environment as Worker vars (`CLOUDFLARE_INCLUDE_PROCESS_ENV`), and state folders persist between runs, so a rerun in the same work folder can find an old approval card. Delete the folder for a clean run. Nothing stops `--work-dir` from pointing inside the repo.
- The check that a tick-less push reaches us has a margin of 30 seconds (a 90 second reply against our first poll at 60). On a slow machine it fails loudly instead of passing falsely. It did once while the machine was busy.

## Ideas beyond the scope

- Report the CORE-SEND-003 runner defect upstream to a2a-tck.
- Offer `Last-Modified` on the card from a stored card revision time.
- A `Message` reply for an agent whose run answers in one turn, if a client ever needs it.

## Steps for Dom

None that need an account or a dashboard. To rerun everything from a clean machine, the Hermes script needs uv 0.13 or newer and downloads CPython 3.14.10 on first use.
