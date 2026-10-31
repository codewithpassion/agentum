# AA.3 review

Status: blocked after round 3. Four must-fix items stay open, listed under "Open findings". The rest of the task is in, and `bun run check`, `bun run test` and `bun run build` pass at the head commit apart from one workerd test noted below.

## Verdicts

- Round 1 (5b8e39a): not clean, nine must-fix. A peer's answer landed on the newest of several open questions. The answer reached the model with no peer envelope. A revoke or cancel before the run row existed left a live run on a terminal task. A start failure after the run row committed left a queued run under a failed task. Revoke had no recovery. The sweep missed an INPUT_REQUIRED task whose question had closed. The hourly limit was read then insert. `openTask` rethrew a raw start error to the peer. A run handed on by `send_message` carried no gate. All fixed in 7a69554, with the state change and its push rows, and the revoke writes, moved into `atomic`.
- Round 2 (7a69554, fix commits only): not clean, eight must-fix. `move` decided it had won by state and timestamp, so two callers in one millisecond both won. A retried answer was not deduplicated. The sweep did not recover tasks open on an ended connection. A revoke between the connection check and the task insert left a live task. The sweep missed a closed first question while another was open. Three tests were missing (push guard, child-run claim refusal, start failure after commit). Fixed in c7ad457.
- Round 3 (c7ad457, fix commits only): not clean, four must-fix. After two fix rounds this stops here, as the process says. See below.

## Open findings

1. `a2a/tasks.ts` `move`, `stamp`: `lastStamp` lives in the service instance, and `composeWith` builds a new instance per request, so the stamp does not separate two requests in one millisecond. Two instances can both pass `after.updatedAt === at` and both queue pushes, and a double approve can start two runs. The test passes only because the fixture shares one instance. A fix that needs no schema change: guard the push inserts on SQLite's `changes() > 0` right after the UPDATE (the first insert follows the UPDATE, and each later one follows an insert that only landed if the UPDATE did), and make the stamp unique across instances with a random sub-millisecond suffix, or read the winner from the update's own row count by adding it to the `Atomic` port.
2. `a2a/tasks.ts` `sweep`, the INPUT_REQUIRED branch: every healthy INPUT_REQUIRED task is now a candidate and keeps its old `updatedAt`, so 100 of them fill the batch and starve newer tasks that need action, for up to the 24 hour question limit. Fix: bound the INPUT_REQUIRED part to tasks whose open question's text differs from the status text in SQL, or give the sweep a rotating cursor.
3. `a2a/tasks.ts` `continueTask`: the answer's `messageId` is recorded in the log only after `answerAsPeer` commits. If the request dies between the two, the peer's retry answers the next open question. The dedupe needs a marker written in the same atomic write as the answer, which needs a column or a table. That is a schema change, so it belongs to a contract task (an `a2a_answered_messages` table, or `last_answer_message_id` on `a2a_tasks`). A `run_requests` answer cannot carry it, because the answer schema is strict.
4. `a2a/tasks-races.test.ts` "a peer starting a run on a managed agent is refused by the runs service itself": the fixture has no managed adapter, so the refusal it sees is "No runtime is registered for managed agents", and removing `startedByPeer` still passes. It needs a managed adapter stub and the real message.

## Settled in AA.3 (the two open points in "What the agent sees", and the investigation)

- A machine daemon too old to report `currentApprovals`: a peer run, and any run that descends from one (`runs/peer-root.ts`), is refused at the claim, as an artifact run already was. Tested.
- The managed runtime does not call `needsApproval`. `publish` refuses a managed agent, `sendMessage` and `approveTask` refuse one published earlier, and `startRun` refuses a managed agent for a peer's own start and for a hand-off from a peer's run. The task allowed refusing instead of gating.
- Every tool path goes through `needsApproval`, with evidence (a read-only pass over the code, checked by the dispatcher):
  - Cloud: one `beforeTool` hook covers the run's whole registry, platform MCP tools and connector tools included (`apps/web/src/server/pi-run-gate.ts:361`, `pi-run.ts:257,369`). `ask_user` and `request_human_takeover` are exempt by name, because they are questions to a person. Dry runs skip read-only calls, and a peer cannot start a dry run.
  - Machine: with `claim.currentApprovals` the daemon asks for every tool, `claim.mcpServers` keys included (`apps/daemon/src/approvals.ts:291-302`, `executor.ts:318-327`). The claim now guarantees a peer run has it.
  - Platform `/mcp` and `/api/proxy` take a run token with no `needsApproval` check of their own (`routes/mcp.ts:367-436`, `routes/proxy.ts:644-720`). Settled as acceptable: the runtime's gate is the control. On the cloud runtime the token is in pi-durable's MCP headers and not in the VM env, and `web_fetch` refuses the app's own hosts. On a machine it sits in the MCP config handed to Claude Code, readable only through Bash or Read, and both ask at `tool_policy = ask`. A server-side guard on `/mcp` for peer-rooted runs is listed below as an idea.
  - `send_message` from a peer run starts a child run. `needsApproval` now follows the parent chain, so the child asks for every tool too, and a managed agent cannot take it.
  - Whether Claude Code's `PreToolUse` fires inside `Task` subagents cannot be checked from the repo. Only the `Task` call itself is confirmed gated.
  - `pi-durable` `codemode.js` calls `global.execute` and would skip the hook. `apps/web` does not install it.
- A peer's answer to a question reaches the model inside the peer envelope. The `request.answered` event keeps the plain text.

## Nits left

- `answeredBefore` ignores `taskId`, so a `messageId` reused on another task returns that task unanswered. A token-shaped `messageId` (`sk-...`) is redacted in the log, so its retry is not recognised. The lookup scans the workspace's `a2a.message_received` events with no time bound.
- `move` returns null after three lost tries, and `cancelTask` then says the task has ended when it has not. Rare.
- No test for the connection-active guard on the insert, the `updated_at` version guard, the retry loop, the same-state short circuit, `alongside` leaving `updatedAt` alone, the duplicate `messageId` at the last place, or `cancelTask` reading the fresh `runId`.
- `taskOfRun` scans `a2a_tasks` on every handled event, and the sweep scans it every minute. `a2a_tasks` has no index on `run_id` or `state` (the AA.1 contract left it out).
- Refused and rate-limited messages each write an event with no bound, so a peer can flood the log.
- `peerRootOf` returns null if a parent row is missing, which opens the gate. No path reaches it, since runs are never deleted and depth is capped.
- `run_requests.answered_by` holds a connection id when `answered_via` is `a2a`, and the column comment says Clerk user id. The request card (`settledLine`) will look the id up as a person and print "an outside agent". AA.7 should label it from the connection.
- A refused peer run blocks that agent's newer runs on an old daemon until the claim expires, as artifact runs already do.
- `peerHost` in `requests.ts` and `hostOf` in `a2a/task-view.ts` do the same job, and `desk.ts` has a third copy.
- `tasks.ts` is about 1,700 lines.
- The fixture uses a cloud adapter that starts nothing, so tests move runs by hand. The fake runtime has two tests (auto and approve, to completed).
- `bun run test` timed out once in `ArtifactRoom admission ... in workerd` (120 second limit) in two of three full runs, and passed alone in 56 seconds and in the third full run. It is a load flake, not this task.

## Ideas beyond the scope

- A server-side guard on `/mcp` and `/api/proxy` for runs whose root is a peer, as a second control behind the runtime's gate.
- A `version` or `claim` column on `a2a_tasks`, and a marker table for answered messages, in a contract task, to close findings 1 and 3 for good.
- The status text of an INPUT_REQUIRED task lists only the oldest question. A peer that wants all of them answered gets them one message at a time.
- AA.8's live checks should include Claude Code `Task` subagents under `tool_policy = ask`.
- AA.5 can drop its own tick entry for the sweep: `tick/a2a-tasks.ts` already runs `a2aTasks.sweep` every minute. It must read `StreamResponse` push bodies as `{ task }`, and the outbox `headers` (sealed with binding `{ field: "headers", rowId, table: "a2a_outbox", workspaceId }`) may be null when a config has no credentials and no token.
- AA.4 maps `A2aTaskError.errorName`, `A2aRateLimitError.retryAfterSeconds`, `ServiceError` and `ForbiddenError`. The hop count it puts on the peer principal is read again from message metadata by the service.
- AA.7 shows `peer`, `host`, `org` and `text` of a Needs you card as plain text: all four come from the peer.

## Steps for Dom

None.
