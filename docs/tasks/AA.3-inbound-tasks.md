---
id: AA.3
title: "Inbound tasks: policy gate, runs, state sync, tool gate, loop guard"
milestone: AA
size: L
status: in_progress
depends_on: [AA.2]
branch: task/AA.3-inbound-tasks
lane: services
executor: claude
---

Spec: `docs/v3/agent-connections.md`, the sections "A2A mapping", "What the agent sees" and "Policies on a connection". It wins over anything else.

## Scope
`packages/services/src/a2a/tasks.ts`, a factory built in `composeWith`. No HTTP.

- `sendMessage(peer, request)`: refuses `inbound_policy = off` and non-text parts (JSON data parts become JSON text). A text part with `mediaType: "text/plain"` is text, because Hermes sends that. A client-chosen `contextId` is accepted. Every unfinished task returned carries a `status.message` saying what it waits for, because Hermes reads that as the reply and doesn't poll. Enforces the hourly limit and the hop cap. Deduplicates on `(connection, messageId)`. Handles `taskId` and `contextId` as spec section 3.4 says: a mismatch is refused, a message to a terminal task gets `UnsupportedOperationError`, and an unknown task gets `TaskNotFoundError`.
- `inbound_policy = approve` puts the task in `TASK_STATE_AUTH_REQUIRED` with a status message saying a person must approve. `approveTask` and `declineTask` are for any session member, and decline ends in `TASK_STATE_REJECTED`. `auto` starts the run at once.
- The run goes through `startRun` with the `peer` principal, session origin `a2a`, external key `<connectionId>:<contextId>`, and reply target `{ kind: "a2a", taskId }`. A gateway registered in `compose.ts` beside `inbox.gateway` and `slackGateway` stores the result.
- The text is wrapped by the speaker envelope with `from.kind: "peer"` (extending `buildSpeakerEnvelope` and the protocol schema), naming the peer's agent and host and stating that it is outside input.
- State sync through `events.onAppend`: `run.started`, `run.finished`, `run.failed`, `run.cancelled`, `run.interrupted` and `request.opened` move the task as the design's table says, with a minute-tick sweep for anything missed. A failed task's text never includes the internal error.
- A `question` request on a peer run moves the task to `TASK_STATE_INPUT_REQUIRED` with the question as the status message. The next message on that `taskId` answers the request through the requests service and returns the task to `WORKING`. An answer that arrives when no question is open is refused.
- Every state change queues a `push` outbox row for each of the task's push configs, with a `StreamResponse` body. Push config create, get, list and delete go here, validated by `connectors/safe-url.ts` with credentials encrypted. A limit of 5 per task.
- `getTask`, `listTasks` and `cancelTask` are scoped to the calling connection, and another connection's task gets `TaskNotFoundError`. `historyLength` is honoured. The hook from AA.2's revoke rejects waiting tasks and cancels runs.
- Tool gate: in `requests.needsApproval`, a run on a connection with `tool_policy = ask` returns true for every tool.
- Investigate and settle the two open points in "What the agent sees", and record the outcome in the review file:
  - A peer run must not be claimable by a daemon that doesn't report `currentApprovals`.
  - The managed runtime doesn't call `needsApproval`. Either route its tools through the same gate, or make AA.2's `publish` refuse a managed agent. Refusing is fine if gating takes real work.
  - Also confirm that every platform MCP tool and connector call on the cloud and machine runtimes goes through `needsApproval`. A tool that skips it must be gated too, because read tools can leak data to a peer.
- Needs you: pending tasks and pending connection approvals reach `desk.railSources`, each with what a person needs to decide (peer, host, full text), following the rail rules in `docs/ux-review/rail/spec.md`.

## Check
- Service tests against `migrated()` with the fake runtime cover, each as its own test:
  - Each policy from message to final state, and decline ending in `REJECTED`.
  - A retry with the same `messageId` returning the same task and starting no second run.
  - The hourly limit, and a hop count above the cap refused.
  - Every run outcome mapped to its state, and the internal error absent from the failed task.
  - The `INPUT_REQUIRED` answer path, and an answer with no question open refused.
  - One connection failing to read, cancel or message another's task.
  - Revoke rejecting a waiting task and cancelling a running run.
  - `needsApproval` true for every tool at `tool_policy = ask` and following the agent's rules at `agent_rules`.
  - The peer run having `onBehalfOfUserId` null, and the stored input carrying the peer envelope.
  - Needs you listing a waiting message and dropping it once decided.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-31: created.
- 2026-11-01: dispatched.
