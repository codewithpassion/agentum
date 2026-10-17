# C.13 review

Task: C gate fixes, MCP sessions and the next waiting run. Branch task/C.13-gate-fixes.

## Verdicts

- Round 1 (c1f0191): must-fix, 1 must-fix, 14 nits.
- Fix round 1 (dccef3f): clean, 0 must-fix, 5 nits.

The round 1 must-fix was a deadlock. `startOnce` in `pi-run-core.ts` failed a run with an unrunnable model inside the `starting` turn. The new offer-next-on-end then started the session's next run on the same Durable Object, and that start waited on the turn. The failing completion now runs in `start` after the turn. A test reproduces the deadlock (it times out against the old code).

## What changed

The MCP bridge keeps one session per server URL for the life of the Durable Object (`McpSessions`, passed from `PiRun`). Initialize stores `Mcp-Session-Id`, sends `notifications/initialized`, and later `tools/list` and `tools/call` carry the session id and `Mcp-Protocol-Version`. A request that carried a session id and got 400 or 404 initializes again and retries once. Concurrent callers share one initialize. A stateless server still works and gets no session header.

When a cloud run ends done, failed or cancelled, `offerNextWaiting` in `runs.ts` offers the agent's oldest waiting run, through the runtime flag `offerNextOnEnd` that only the cloud runtime sets. `claimRun` still keeps one running run per agent. A failure to offer is logged, and the sweep stays the backstop.

`scripts/dev/stub-mcp.ts` has a stateful mode (`--stateful`, `stateful: true`, `dropSessions()`).

## Checks

- Live on a local dev server (faux model): two messages to one cloud agent, only the first offered, both done 621 ms apart. Two more sessions of the same agent chained the same way. A cancelled slow run started its queued successor 1.4 s later.
- Live with the stateful stub through a tunnel and the connector proxy: initialize, `notifications/initialized`, `tools/list` and `tools/call` all carried the session id. After `dropSessions()` the next run re-initialized and its call worked.
- `bun run check && bun run test && bun run build` pass.

## Nits left

1. Test (g), a non-cloud agent that must not trigger an offer, is not written. The services test setup registers only the cloud adapter.
2. `runs.ts`: the next-run offer only tries the agent's oldest waiting run. If an older run in its session still has pending files, nothing starts until the sweep.
3. `runs.ts`: a cloud run the lease reaper marks `interrupted` does not offer the next run. The task names done, failed and cancelled.
4. `runs.ts`: every completion on every runtime does one more adapter lookup.
5. `pi-run-mcp.ts`: any 400 with a session id counts as a lost session, and the negotiated `protocolVersion` is dropped in favour of 2025-06-18. A server that negotiates an older version and checks the header would answer 400.
6. `pi-run-mcp.ts`: a network error or timeout on `notifications/initialized` rejects initialize, though the comment says a refused notification is not an error.
7. `pi-run-mcp.ts`: sessions are keyed by URL only and are never ended with DELETE.
8. No test for the 30 s initialize timeout, or for the protocol header on `notifications/initialized` from a stateless server.
9. `pi-run-core.ts`: two starts of one unrunnable run at the same moment now fail it in two overlapping `completeRun` calls. The platform answers the second with a conflict.

## Ideas beyond the scope

- Offer the next run when the lease reaper interrupts a cloud run.
- Read `protocolVersion` from the initialize result and send that, and end sessions with DELETE when a run's object goes idle.
- Steering a message into a busy session, which C.3 left out.

## Steps for Dom

None.
