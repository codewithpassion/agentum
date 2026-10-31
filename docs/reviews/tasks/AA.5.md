# AA.5 review

Blocked after round 5 (two controller-approved fix rounds used). The last must-fix was removed in the head commit without a further review, so the head is unreviewed by one small change (below). `bun run check` passes at the head commit. Targeted suites pass (`packages/services` a2a, desk, desk-api, slack, `packages/a2a`, the web transport, route, tick, compose and request card tests).

## Verdicts

- Round 1 (e677aeb9): not clean, 12 must-fix. Fixed in 4fe2e38b.
- Round 2 (4fe2e38b, fix commit only): not clean, 8 must-fix. Fixed in 9e492f96.
- Round 3 (9e492f96, fix commit only): not clean, 2 must-fix (nobody pinged about a waiting send card, and the desk API approved a clipped message).
- Controller decision after round 3: fix both. A waiting send card is answered on the page, in Needs you, where the whole text shows (tested through `desk.railSources`); Slack gets a plain notice naming the peer, with a link and no buttons and none of the text; the one hour expiry stays and an expiry tells the agent nobody approved the message. The desk API returns the whole text and never lets an approval act on text the approver could not see. `fetchCard` is wired in `compose.ts` through the real transport (`createCardFetcher(infra.peerFetch)`, tested in `apps/web/src/server/compose-a2a.test.ts`). Up to two more review rounds.
- Round 4 (6430f0c7, fix commit only): not clean, 1 must-fix. The desk's task-row fallback showed unscrubbed text when scrubbing made the card longer than the size `send` had checked. Fixed in 98652747: `send` closes such a card, fails the task and tells the agent to shorten the message, and the fallback was scrubbed.
- Round 5 (98652747, fix commit only): not clean, 1 must-fix. The fallback was still weaker than the card (`redactText` only, no vault masker). Fixed in the head commit by deleting the fallback: the desk shows the card's own scrubbed text, and for a cut card the cut copy, which the desk API refuses to allow. `send` already refuses every cut card, so it cannot occur. This last change has no review round.

## Open

Nothing is open as a known must-fix. The head commit's change (the fallback deleted, `sendDetail` made synchronous, its two tests replaced by one that a cut card shows the cut copy and not the row's text) was not reviewed. A controller decision is needed on whether to merge it as is or send it for one more review.

## Nits left

- `byRequestId` is keyed by connection, so a retry from another session of the same agent takes the answer and cancels the wake for the first session. How often depends on how AA.6 picks `requestId`.
- `markRead` does nothing while a wake claim is in flight, so a retry at that moment hands the answer over and the wake repeats it.
- A cut answer in a wake ends in only "…" and does not say it was cut or give the task id for `get`. Halving cuts more than needed (30,000 characters drop to 15,000), and the comment on `WAKE_TEXT_FLOOR` says "never below" while the cut can reach 937.
- `cardInput` leaves the peer name uncapped. A name near 8 KB makes every approve-policy send fail with "Shorten it".
- A send the card allowed but `failLocal` refused (the card did not carry the text) still reads "Allowed once" on the card, and its agent is not woken. Mail has `mailSendError` for this.
- The `reason` of a permanent wake refusal is a class name such as `ZodError`. The `ZodError` branch of `settleFailedWake` and the Slack DM case have no test of their own.
- "Always allow" is still offered for an `a2a_send` card in Slack (no longer posted), the desk API and `requests.ts`. It saves a rule `send` never reads, so the next send still asks. The web card hides it.
- A local failure, a decline, the 24 hour stop or a failed approved send mark the task read. If the calling run has ended, nobody is told, so a Slack thread stays silent. The spec's "wakes nothing" covers a revoke only.
- A crash between the wake claim and `startRun` leaves a `#wake` mark with no run, and nothing recovers it. The wake window uses `updatedAt`, so a result unread for a day is dropped without a record.
- `settleApprovals` takes the 20 oldest waiting rows, so unanswered cards can hold newer ones until they expire (bounded by the card's expiry).
- Each wake adds one to the depth, so a session allows about three rounds with a peer, and the refusal then says the message "passed through more than 3 agents".
- A wake run has a `parentRunId`, so the task receipt and the agent map read it as a hand-off from the same agent (`tasks/receipt.ts`, `tasks/service.ts`, `db/src/map.ts`).
- The wake state lives in `result_read_at`: a plain time means the agent read it, the time plus `#wake` means a wake claimed it. It was chosen so the hourly limit can be checked in the claim statement with no schema change. Another task changing schema could give it a column.
- The tick composes without `defer`, so `waitUntil` work from an in-process dispatch during a tick is not kept alive. `readBounded` in `a2a-transport.ts` repeats `readCapped` in the client, and `readAgentCard` has no caller outside tests. The send runs inline in the listener of the person's answer, so the click can wait 15 seconds or more.
- A connection back in `needs_approval` after its card moved fails its open tasks for good. On an HTTP+JSON peer without `ListTasks`, a 404 after a timed-out send reads as "no longer knows this task".
- No index on `a2a_outbound_tasks (connection_id)` or `(request_id)`; the guarded insert and the claim count by connection. AA.1 noted the same gap for the other tables.

- Round 4 and 5 nits: a failed send for a too-long card keeps its `requestId`, so a shortened retry with the same id gets the old failed task (deleting the row would fix this and its slot in the hourly count); `closeCard` appends `request.cancelled` even when the card was already answered; a crash between `closeCard` and `failLocal` converges through the tick but with the reason "Nobody approved this message in time"; the Slack notice can still post for a card closed a moment later and is never edited; a peer name in the Slack notice can carry `<@U...>` mentions that `escapeSlackKeepingMentions` lets through; the notice posts only for a Slack-reply run or a run whose person has a Slack link; `canInteract` in `slack/requests.ts` has no `a2a_send` guard; a refusal in our own words is inside the peer envelope; a refused row keeps its raw text, so the first 160 characters of it reach a wake run's input; a person's deny note is dropped; a person-cancelled calling run still gets the refusal wake; `desk-api.ts`'s refusal says to answer in Harbourmaster, where a cut card cannot be allowed either; `cardHoldsText`, `shownText` and `cardCarriesText` are three near copies.

## Deviations from the task file

- No second sweep job in `tick/a2a.ts`: `tick/a2a-tasks.ts` (AA.3) already runs the sweep every minute, and a duplicate job name makes `runTick` throw.
- A wake counts against the hourly limit by being counted on its task (see above). It has no row of its own.
- The routes file `routes/a2a-webhooks.ts` is mounted with `app.use("/a2a/*", composeServices)` and `app.route("/a2a", a2aWebhookRoutes())` in `server.ts`. AA.4 will add the same neighbours, so expect a one-line conflict at the merge.
- `packages/services/src/connectors/safe-url.ts` `safeFetch` takes a narrower fetch type (`(input: string, init?) => Promise<Response>`), so the app's wrapped fetch fits. Callers are unchanged.
- `card-peer.ts` `chooseInterface` now calls `pickInterface` from `@repo/a2a/client`, so what a person approves is what the client calls.
- `apps/web` gained the `@repo/a2a` dependency, and `packages/services` exports `connectors/safe-url`, `a2a/outbound` and `a2a/outbox`.
- Slack posts no approval card for `a2a_send`, only a notice (`postSendNotice`). A decline or expiry now wakes an agent whose run ended, with our own words in the peer envelope.
- The approval card UI (`request-card.tsx`, `request-card-logic.ts`) and `approvalSummary` in `@repo/protocol` got an `a2a_send` case, because AA.7 covers inbound cards only.
- `expireStaleInvites` is a new method on the connections service, for the tick.

## Ideas beyond the scope

- Continue a peer task that is `INPUT_REQUIRED` (a `send` with the remote task id), and cancel an outbound task (`client.cancelTask` has no caller).
- A `contextId` per session and connection, so a peer that keeps context across messages can, at the price of finding the right task by `ListTasks`.
- A list of outbound tasks per connection for the connection page (AA.7).
- AA.6: `answer` from `outbound.get` and `send` is already inside the peer envelope, so the tool should pass it on as it is. `runId` is the outbound task id, `statusText` holds the words for a waiting task, and `get` takes a run principal of the connection's own agent.

## Steps for Dom

None.
