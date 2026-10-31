# AA.3 review

Clean after five review rounds. `bun run check`, `bun run test` and `bun run build` pass at the head commit.

## Verdicts

- Round 1 (5b8e39a): not clean, nine must-fix. A peer's answer landed on the newest of several open questions. The answer reached the model with no peer envelope. A revoke or cancel before the run row existed left a live run on a terminal task. A start failure after the run row committed left a queued run under a failed task. Revoke had no recovery. The sweep missed an INPUT_REQUIRED task whose question had closed. The hourly limit was read then insert. `openTask` rethrew a raw start error to the peer. A run handed on by `send_message` carried no gate. All fixed in 7a69554, with a state change and its push rows, and the revoke writes, moved into `atomic`.
- Round 2 (7a69554, fix commits only): not clean, eight must-fix. `move` decided it had won by state and timestamp. A retried answer was not deduplicated. The sweep did not recover tasks open on an ended connection. A revoke between the connection check and the task insert left a live task. The sweep missed a closed first question while another was open. Three tests were missing. Fixed in c7ad457.
- Round 3 (c7ad457, fix commits only): not clean, four must-fix. The stamp in `move` was per service instance and compose builds one per request. The sweep let a full batch of healthy INPUT_REQUIRED tasks hide a stuck one. A retried answer could answer the next question if the request died after the answer. The managed-refusal test was vacuous.
- Controller decision after round 3 (over the two-round limit): fix all four, with a schema change allowed in this task because no other AA task was changing schema. One generated migration, `0037_charming_firestar.sql`, with `migrations/meta/`. Up to two more rounds, on the fix commits only.
  - `move`: the winner comes from the database. The update writes a `move_token` no other call has, matches only a task still in one of the states `from`, and for a person's decision also needs `decided_at IS NULL`. The caller whose token is on the row afterwards won, and only it queues pushes (guarded in the same atomic write) or starts a run. The instance-level stamp and the retry loop are gone. Tests race two service instances, as compose builds one per request, on one approve and on an approve against a decline.
  - Sweep: `a2a_tasks.swept_at`. The sweep takes the least recently swept tasks first, as `runs.swept_at` does, and stamps each batch (batch 50). A test puts 56 healthy INPUT_REQUIRED tasks ahead of a stuck one and reaches it within three sweeps.
  - Answers: `a2a_answer_markers`, unique on (connection, message id), holding the task and request. The marker is written first and the answer second. A retry that finds it returns the task and answers nothing. A request that dies between the two leaves the question open for a message with a new id. Tests cover both.
  - Managed refusal: the fixture registers a managed adapter and the test asserts the real refusal text. Removing the fix once made it fail, and the fix was restored.
  - Also added: indexes on `a2a_tasks (run_id)` and `(state, swept_at)`, which round 1 had flagged.
- Round 4 (70d7812, fix commits only): not clean, one must-fix. `giveAnswer` deleted the marker on any error from `answerAsPeer`, including errors after the answer committed (the announce and the wake of the run), so the retry answered the next question. Fixed in 5d7f394: the marker is released only while the question is still `pending`. The committed-then-failed case and the failed-before-commit case each have a test, and removing the rule made the first fail. Three of the nits were done with it: a throw in `settle` is caught per task, a marked message id is honoured with or without a task id, and the orphaned doc comment is gone.
- Round 5 (5d7f394, fix commit only): clean.

## Settled in AA.3 (the two open points in "What the agent sees", and the investigation)

- A machine daemon too old to report `currentApprovals`: a peer run, and any run that descends from one (`runs/peer-root.ts`), is refused at the claim, as an artifact run already was. Tested.
- The managed runtime does not call `needsApproval`. `publish` refuses a managed agent, `sendMessage` and `approveTask` refuse one published earlier, and `startRun` refuses a managed agent for a peer's own start and for a hand-off from a peer's run. The task allowed refusing instead of gating.
- Every tool path goes through `needsApproval`, with evidence (a read-only pass over the code, checked by the dispatcher):
  - Cloud: one `beforeTool` hook covers the run's whole registry, platform MCP tools and connector tools included (`apps/web/src/server/pi-run-gate.ts:361`, `pi-run.ts:257,369`). `ask_user` and `request_human_takeover` are exempt by name, because they are questions to a person. Dry runs skip read-only calls, and a peer cannot start a dry run.
  - Machine: with `claim.currentApprovals` the daemon asks for every tool, `claim.mcpServers` keys included (`apps/daemon/src/approvals.ts:291-302`, `executor.ts:318-327`). The claim now guarantees a peer run has it.
  - Platform `/mcp` and `/api/proxy` take a run token with no `needsApproval` check of their own (`routes/mcp.ts:367-436`, `routes/proxy.ts:644-720`). Settled as acceptable: the runtime's gate is the control. On the cloud runtime the token is in pi-durable's MCP headers and not in the VM env, and `web_fetch` refuses the app's own hosts. On a machine it sits in the MCP config handed to Claude Code, readable only through Bash or Read, and both ask at `tool_policy = ask`.
  - `send_message` from a peer run starts a child run. `needsApproval` follows the parent chain, so the child asks for every tool too, and a managed agent cannot take it.
  - Whether Claude Code's `PreToolUse` fires inside `Task` subagents cannot be checked from the repo. Only the `Task` call itself is confirmed gated. AA.8 should check it live.
  - `pi-durable` `codemode.js` calls `global.execute` and would skip the hook. `apps/web` does not install it.
- A peer's answer to a question reaches the model inside the peer envelope. The `request.answered` event keeps the plain text.
- `docs/v3/agent-connections.md` ("What the agent sees") now says the two points are settled.

## Nits left

- A marker stays when the question closed without this answer (expired, cancelled, answered by another message). The first send is refused, and a retry of the same id then returns the task with no error. If a retry's refusal never reached the peer, it may think its text landed.
- If `questionStillOpen` or `releaseAnswer` throws inside the catch in `giveAnswer`, the original error is lost. Comments there ("takes its marker back", "Someone answered it") are stale for a question that expired or was cancelled, and so is the "Already answered" message in `requests.ts`.
- After a commit where the announce threw, the retry returns the task without `settleQuestion`, so it can show the closed question until an event or the sweep corrects it, and `lastInAt` and `a2a.message_received` are not written. If the announce or the wake of the run throws after commit, nothing re-wakes the run but the lease reaper. `requests.answer` has the same shape.
- `move` without a version guard lets a stale `settleQuestion` write over newer state, and an INPUT_REQUIRED to INPUT_REQUIRED move can queue a duplicate push when two callers race. The sweep repairs the first.
- A winner's token can be overwritten before the read-back, so `approveTask` reports "someone already decided" and records no `a2a.message_approved` when a peer cancel lands in that gap. No run starts, which is right.
- The marker lookup comes before the `contextId` mismatch check, so a mismatched retry is not refused. A message id that opened a task is accepted as an answer on a task with a `taskId`, because dedupe of task-opening ids only runs without one.
- If the process dies mid-batch, tasks stamped but not acted on wait one rotation (about N/50 minutes). One throwing `onConnectionRevoked` in the sweep's `abandoned` loop stops the sweep before it reaches `settle`.
- `a2a_answer_markers.request_id` is written and never read. The `swept_at` column in `a2a_tasks_state_swept_idx` is not used by the sort, which is on `coalesce(swept_at, created_at)`. The `decided_at IS NULL` guard is redundant while nothing returns a task to AUTH_REQUIRED.
- No committed test for: the connection-active guard on the insert, the same-state short circuit, `cancelTask` reading the fresh `runId`, the expired or cancelled paths through `giveAnswer`, or the per-task catch in the sweep.
- Refused and rate-limited messages each write an event with no bound, so a peer can flood the log.
- `peerRootOf` returns null if a parent row is missing, which would open the gate. No path reaches it, since runs are never deleted and depth is capped.
- `run_requests.answered_by` holds a connection id when `answered_via` is `a2a`, and its column comment says Clerk user id. The request card (`settledLine`) will look the id up as a person and print "an outside agent". AA.7 should label it from the connection.
- A refused peer run blocks that agent's newer runs on an old daemon until the claim expires, as artifact runs already do.
- `peerHost` in `requests.ts`, `hostOf` in `a2a/task-view.ts` and a copy in `desk.ts` do the same job. `tasks.ts` is about 1,800 lines.
- The fixture uses a cloud adapter that starts nothing, so tests move runs by hand. The fake runtime has two tests (auto and approve, through to completed).
- `bun run test` timed out once or twice in `ArtifactRoom admission ... in workerd` (120 second limit) in earlier full runs. It is a known load flake, not this task: it passes alone in about 56 seconds, and the last full runs passed it.

## Ideas beyond the scope

- A server-side guard on `/mcp` and `/api/proxy` for runs whose root is a peer, as a second control behind the runtime's gate.
- The status text of an INPUT_REQUIRED task lists only the oldest question. A peer that wants all of them answered gets them one message at a time.
- AA.5 can drop its own tick entry for the sweep: `apps/web/src/server/tick/a2a-tasks.ts` already runs `a2aTasks.sweep` every minute. Push bodies are `{ task }`, and the outbox `headers` (sealed with binding `{ field: "headers", rowId, table: "a2a_outbox", workspaceId }`) may be null when a config has no credentials and no token.
- AA.4 maps `A2aTaskError.errorName`, `A2aRateLimitError.retryAfterSeconds`, `ServiceError` and `ForbiddenError`. The hop count it puts on the peer principal is read again from message metadata by the service.
- AA.7 shows `peer`, `host`, `org` and `text` of a Needs you card as plain text: all four come from the peer.

## Steps for Dom

None.
