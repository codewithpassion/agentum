# AA.11 review record

Gate 1 fixes: wakes carry no delegation and ask for tools, managed refused, revoke reaches the whole chain. Findings M1, M2, M3 and N9 of `docs/reviews/AA-1.md`. Spec: `docs/v3/agent-connections.md`.

## Rounds

- Round 1, at 04d705c4: must-fix. `outbound.get` had no managed check, so a run of an agent moved to managed after a send could still read a peer's answer.
- Round 2, at 2c8d7b03, on the fix commit only: clean.

Fixes: `refuseManagedRun` guards `get` for run principals as well as `send`, and its own message (`MANAGED_RUN_REFUSAL`) says a run of a managed agent can't use connections. The revoke hook catches a failed chain read so its events still get written, and the sweep finishes the cancels. A full-depth revoke test was added.

## What changed

- A wake starts with `wakeOf` (a trusted start option, not in `startRunInputSchema`). `deriveSubject` gives it the actor `{ kind: "peer", id: connection.id }`, `onBehalfOfUserId` null, and keeps the calling run's parent and depth. Only a run principal's start honours it.
- `peerRootsOf` returns every peer link in a run's chain. `peerAsksEveryTool` asks when any link is not an active `agent_rules` connection. A daemon without `currentApprovals` can't claim a wake. `answerAsPeer` refuses a run that has a parent, so no peer can answer a wake's question.
- `refusePeerHandoffToManaged` refuses a wake. `addOutbound` refuses a managed agent in `publish`'s words, `outbound.admit` and `outbound.get` refuse a run of one, and `pairableAgent` hands out no code for one (N9).
- `onConnectionRevoked` and the sweep cancel live runs whose parent chain reaches a run with actor peer = the connection, found by one recursive query that walks up from each live run (so a hand-off outlives its parent's end). Cancels go 50 at a time, 5 rounds per revoke, and the sweep takes one batch a tick. `runs.cancelRun` is unchanged.
- The spec's wake paragraph, the `tool_policy` row, the revoke bullet and the managed bullet say so.
- Tests: wake subject and credential seam (`outbound-wake.test.ts`), wake gate (`tool-gate.test.ts`, `machine-claim.test.ts`), revoke and sweep (`tasks-revoke.test.ts`), `addOutbound` and pairing for managed, `subject.test.ts`. Repro tests F1, F1b, F2 and F3 are all covered.

## Decisions

- The wake run's actor is a peer, so the Slack approval DM (needs a person) isn't sent for a wake. The ask still shows in Needs you through the open request, as for any peer or trigger run.
- Wakes written before this change (agent actor) are not found by the revoke walk. The spec's `a2a-wake:` request id lookup was dropped because new wakes carry the connection as actor. Only staging data is affected.

## Nits left

- The sweep's chain query has no workspace scope, so it reads all of `runs` every minute (no index leads with `status`). The revoke query uses `runs_workspace_status_idx`.
- `machine-claim.test.ts` hand-writes the wake row, so those two claim tests also pass without the change. The refusal rests on the wake's peer actor, which the other tests cover.
- No test covers a wake's own hand-off, and none makes `liveRunsReaching` throw inside the revoke hook.
- A wake that replies in a Slack thread drops task output files, because `taskOutputs` needs a person.
- `outbound.listPeers` has no managed check, so `list_agents` in a managed run still lists peers that `send_message` refuses.
- `read_session` and `search_sessions` can still show a managed run peer text written to its visible sessions before the move (close to accepted N3).
- `outbound.get` costs one `findAgent` per call, and `waitFor` polls it every 500 ms.
- A member-started managed parent could hand off to a cloud child that talks to a peer. The spec names only the other direction.
- `peer-ports.test.ts` has no managed case.

## Ideas beyond the scope

- A partial index on live run statuses for the sweep query.
- A server-side guard on `/mcp` and `/api/proxy` for peer-rooted runs, which the spec lists as a possible later addition.

## For Dom

Nothing needs your accounts or dashboards.
