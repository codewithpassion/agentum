# AA.5 review

Blocked after round 3. Two must-fix findings are open and need a controller decision. `bun run check` passes at the head commit. `bun run build` and `bun run test` passed at round 1 (one `guest execution` workerd test timed out under load and passes alone in 90 seconds, the known flake). The targeted suites (`packages/services` a2a, slack, requests, mail, `packages/a2a`, the web transport, route, tick and request card tests) pass at the head commit.

## Verdicts

- Round 1 (e677aeb9): not clean, 12 must-fix. A revoked connection still woke a run, the wake ran as the system principal (depth 0, no peer root, `tool_policy` escaped), `send` and `get` handed over an answer a wake then repeated, the hourly check was separate from the wake claim, peer text reached the agent unwrapped, the card showed masked text while the unmasked text was sent, the web card did not name the peer, the wake batch could be held by rows that cannot wake, the hourly count scanned the events table, the outbox deleted a row before telling the connection, and a revoke left the send card open. All fixed in 4fe2e38b.
- Round 2 (4fe2e38b, fix commit only): not clean, 8 must-fix. A retried send did not mark the answer read, a `ZodError` retried a wake for a day, a long peer name and an answer that grows when escaped broke the wake, a wake into an artifact session failed quietly, a revoke gave no `request.cancelled` event, the Slack card cut the message, and `shownText` fell back to the unmasked text. All fixed in 9e492f96.
- Round 3 (9e492f96, fix commit only): not clean, 2 must-fix, open.

## Open must-fix

1. No one is told a send card is waiting once Slack posts none. `slack/requests.ts` `postCard` now skips an `a2a_send` card (a Slack block holds about 3,000 characters and a person must see the whole text), which also drops the DM for a web run. The card still reaches Needs you and the rail pane, but nothing pings. `requests.open` passes no `ttlMs`, so the card lasts one hour (`APPROVAL_TTL_MS`; mail, also a detached approval, uses 3 days). After the hour `declineSend` records "Nobody answered in time" and marks the task read, so no wake runs, and a person who asked in a Slack thread hears nothing. Possible fix: post a Slack pointer with no buttons and a link, use a 3 day TTL, or both.
2. The desk API lets a client approve a message it saw only part of. `desk.ts` `describe` clips the card input to 2,000 characters (`DETAIL_MAX`) and `desk-api.ts` `decide` accepts allow or always, then `sendApproved` sends the full stored text (a card holds about 8,192 bytes). This was there before round 3, and is the same fault Slack had. Possible fix: refuse an `a2a_send` card in `decide` the way it refuses `takeover` (`desk-api.ts:239`), or return the whole text.

## Nits left

- `byRequestId` is keyed by connection, so a retry from another session of the same agent takes the answer and cancels the wake for the first session. How often depends on how AA.6 picks `requestId`.
- `markRead` does nothing while a wake claim is in flight, so a retry at that moment hands the answer over and the wake repeats it.
- A cut answer in a wake ends in only "…" and does not say it was cut or give the task id for `get`. Halving cuts more than needed (30,000 characters drop to 15,000), and the comment on `WAKE_TEXT_FLOOR` says "never below" while the cut can reach 937.
- `cardInput` leaves the peer name uncapped. A name near 8 KB makes every approve-policy send fail with "Shorten it".
- A send the card allowed but `failLocal` refused (the card did not carry the text) still reads "Allowed once" on the card. Mail has `mailSendError` for this.
- The `reason` of a permanent wake refusal is a class name such as `ZodError`. The `ZodError` branch of `settleFailedWake` and the Slack DM case have no test of their own.
- "Always allow" is still offered for an `a2a_send` card in Slack (no longer posted), the desk API and `requests.ts`. It saves a rule `send` never reads, so the next send still asks. The web card hides it.
- A local failure, a decline, the 24 hour stop or a failed approved send mark the task read. If the calling run has ended, nobody is told, so a Slack thread stays silent. The spec's "wakes nothing" covers a revoke only.
- A crash between the wake claim and `startRun` leaves a `#wake` mark with no run, and nothing recovers it. The wake window uses `updatedAt`, so a result unread for a day is dropped without a record.
- `settleApprovals` takes the 20 oldest waiting rows, so unanswered cards can hold newer ones until they expire (bounded by the card's expiry).
- Each wake adds one to the depth, so a session allows about three rounds with a peer, and the refusal then says the message "passed through more than 3 agents".
- A wake run has a `parentRunId`, so the task receipt and the agent map read it as a hand-off from the same agent (`tasks/receipt.ts`, `tasks/service.ts`, `db/src/map.ts`).
- The wake state lives in `result_read_at`: a plain time means the agent read it, the time plus `#wake` means a wake claimed it. It was chosen so the hourly limit can be checked in the claim statement with no schema change. Another task changing schema could give it a column.
- The result of a refused card (`declineSend`, the 24 hour stop) marks the task read with no event for the first, and `a2a.task_cancelled` for the second.
- The tick composes without `defer`, so `waitUntil` work from an in-process dispatch during a tick is not kept alive. `readBounded` in `a2a-transport.ts` repeats `readCapped` in the client, and `readAgentCard` has no caller outside tests. The send runs inline in the listener of the person's answer, so the click can wait 15 seconds or more.
- A connection back in `needs_approval` after its card moved fails its open tasks for good. On an HTTP+JSON peer without `ListTasks`, a 404 after a timed-out send reads as "no longer knows this task".
- No index on `a2a_outbound_tasks (connection_id)` or `(request_id)`; the guarded insert and the claim count by connection. AA.1 noted the same gap for the other tables.

## Deviations from the task file

- No second sweep job in `tick/a2a.ts`: `tick/a2a-tasks.ts` (AA.3) already runs the sweep every minute, and a duplicate job name makes `runTick` throw.
- A wake counts against the hourly limit by being counted on its task (see above). It has no row of its own.
- The routes file `routes/a2a-webhooks.ts` is mounted with `app.use("/a2a/*", composeServices)` and `app.route("/a2a", a2aWebhookRoutes())` in `server.ts`. AA.4 will add the same neighbours, so expect a one-line conflict at the merge.
- `packages/services/src/connectors/safe-url.ts` `safeFetch` takes a narrower fetch type (`(input: string, init?) => Promise<Response>`), so the app's wrapped fetch fits. Callers are unchanged.
- `card-peer.ts` `chooseInterface` now calls `pickInterface` from `@repo/a2a/client`, so what a person approves is what the client calls.
- `apps/web` gained the `@repo/a2a` dependency, and `packages/services` exports `connectors/safe-url`, `a2a/outbound` and `a2a/outbox`.
- The approval card UI (`request-card.tsx`, `request-card-logic.ts`) and `approvalSummary` in `@repo/protocol` got an `a2a_send` case, because AA.7 covers inbound cards only.
- `expireStaleInvites` is a new method on the connections service, for the tick.

## Ideas beyond the scope

- Continue a peer task that is `INPUT_REQUIRED` (a `send` with the remote task id), and cancel an outbound task (`client.cancelTask` has no caller).
- A `contextId` per session and connection, so a peer that keeps context across messages can, at the price of finding the right task by `ListTasks`.
- A list of outbound tasks per connection for the connection page (AA.7).
- AA.6: `answer` from `outbound.get` and `send` is already inside the peer envelope, so the tool should pass it on as it is. `runId` is the outbound task id, `statusText` holds the words for a waiting task, and `get` takes a run principal of the connection's own agent.

## Steps for Dom

None.
