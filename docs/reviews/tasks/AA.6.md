# AA.6 review record

Agents reach peers through `list_agents`, `send_message` and `get_run`. Spec: `docs/v3/agent-connections.md`, "Our agent calling a peer".

## Rounds

- Round 1, at 9ea89172: must-fix. An hourly-limit refusal reached the agent as the generic "try again" failure. A peer's card name and description went into the `list_agents` text raw, newlines included. `listPeers` read connections without `authorize()`.
- Round 2, at b4f9fc14: clean.

Fixes: `guarded` turns `A2aRateLimitError` into a `conflict` tool error with the wait. `listPeers` puts a peer's name and description on one line, and the tool text quotes them and says they are the peer's own words. `listPeers` calls `authorize()` with `a2a.outbound.read`. A connection id with a wrong agent part is refused, and a card that no longer parses is left out of the list. After the review the coordinator also asked for `admit` to use `hasDestination`, so a corrupt `peer_card` refuses with the "destination is not approved" message and not a `SyntaxError`. Two tests cover this change and the `authorize()` call: both fail when their fix is removed.

## Decisions

- Peers are listed and reached only for a run principal. An API key or OAuth client gets the local list, and a slug with a slash is "no agent" for them.
- A slug is `<connection-slug>/<slugified peer name>`. A live peer must be named whole. A connection that is revoked or switched off goes to the outbound service, which says why.
- `get_run` takes an `aot_` task id as a peer message. A local run id never starts that way.
- A dry run needs no code of its own: `send_message` is a write tool, so `register.ts` records the skip and never calls the port. The service also refuses a dry run.
- `waitMs` for a peer polls `get` every 500 ms in `peer-ports.ts`, capped at the same 25 seconds.
- `RunInfo` gets an optional `statusText`, so a message waiting for approval says what it waits for.

## Nits left

- `waitFor` in `peer-ports.ts` uses `Date.now()` and `setTimeout`, not the injected clock, and polling sits in the port rather than the service.
- "Zero returns at once" is not true for a peer on `auto`: `dispatch` waits on the peer's `SendMessage`, up to the client timeout (15 s), and with `waitMs` at its maximum the call can take about 40 s.
- The tool accepts 100,000 characters but a peer message is capped at 30,000. The send_message description now says so, and the limit shows as a validation error.
- `waitMs` has a test only for a peer on `approve`, none for an early return with a peer's answer.
- No web-layer test for another agent's run sending to a peer or reading its task. `outbound.test.ts` covers both in the service.
- `PeerInfo.outboundPolicy` is used only by tests, and the policy re-check in `listPeers` repeats the SQL filter.
- The web test imports fixtures from `packages/services/src/a2a/` by relative path.
- `destinationOf` is still unguarded in the client builder at `outbound.ts:492`. `admit` now guards it, and a dispatch after an approval reads the same row.

## Beyond scope

- A peer's description could be shown to a person for review when they approve the connection, since it now reaches an agent's context.
- `list_sessions` and the other session tools say "slug as list_agents returns it", which is wrong for a peer slug.

## Steps for Dom

None. No new bindings, secrets or dashboards.
