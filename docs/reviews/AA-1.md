# AA gate review 1, at d071f996

Scope: `git diff aa-start..d071f996` against `docs/v3/agent-connections.md`, CLAUDE.md and "Rules that are easy to break" in `docs/HANDOVER.md`.

## Verdict

Not clean. 4 must-fix, 13 nits. Two decisions are for Dom: whether `tool_policy` gates a wake (inside M1), and a cap on waiting for input (N1). The main problem is the wake. A peer's answer to a message we sent starts a follow-up run that carries the calling person's delegation and can land on a managed agent, and the connection's `tool_policy` does not gate it. Inbound paths held up: pairing, authentication, revoke of tokens, redirects, the dev-only allowances and credential destinations all passed. The AA.8 reasons for the 4 open TCK failures hold.

## Checks run

| Check | Result |
|---|---|
| `bun install --frozen-lockfile` | Passed, 2234 packages |
| `bun run check` | Exit 0. 13 of 13 tasks passed (12 from the turbo cache), `boundary-lint: clean` |
| `bun test` in `packages/a2a` | 153 pass, 0 fail, 447 assertions, 8 files |
| `bun test src/a2a` in `packages/services` | 395 pass, 0 fail, 1156 assertions, 15 files |
| `scripts/e2e/a2a-two-deployments.ts` | Not run (optional). It needs a Clerk dev session, and the run would not reach the wake gap anyway, because no check asks `needsApproval` on a wake |
| Scratch reproduction, `tmp/AA-gate/repro/gate.test.ts` against the real fixtures | 4 tests, 4 fail as predicted: M1 (delegation, and the `tool_policy` question), M2, M3. Output in `tmp/AA-gate/repro/result.log`. Nothing in the worktree changed |

The repo's own suites pass because none of them cover these cases: `tool-gate.test.ts` has no wake case at all.

## Findings

| # | Severity | Finding | Area | Resolution |
|---|---|---|---|---|
| M1 | High | A wake run keeps the calling person's delegation. Whether `tool_policy` also gates it is for Dom | Outbound, gate | Must-fix, plus one decision |
| M2 | High | A managed agent can be woken with a peer's text, and can hold an outbound connection at all | Outbound, managed | Must-fix |
| M3 | Medium | Revoke leaves hand-off runs alive, so "cancels runs in flight for that connection" is only true of the task's own run | Revoke | Must-fix |
| M4 | Medium | `refreshCard` has no caller, so the spec's re-approval when a card moves never happens | Card refresh | Must-fix |
| N1 | Dom's call | One run at a time: an `auto` peer can block an agent indefinitely. Judged below | Availability | Decide before an `auto` peer in production |
| N2 | Nit | Under `inbound_policy = approve`, an answer to a question reaches the run with no person seeing it | Policy | Spec carve-out, worth a line in the spec |
| N3 | Nit | `get_run` in a live run hands peer text to an ungated member run | Gate | Accepted by the spec, stays after M1 |
| N4 | Nit | A stranger can hold all 3 pairing slots for as long as they keep asking, and the unauthenticated path has no rate limit | Pairing | Within the spec's limits. Turning pairing off and on clears them |
| N5 | Nit | A text or data part with an unsupported `mediaType` is accepted (`image/png` on a text part), against the wording of CORE-SEND-003 | A2A | Refuse anything but text and JSON types on those parts |
| N6 | Nit | `listWaiting` is capped at 200, oldest first, and waiting messages never expire. One peer at the limit fills it in 10 hours and hides other peers' messages | Needs you | Expire them, or cap per connection |
| N7 | Nit | Reads, streams and webhook nudges have no limit. Each open stream polls D1 every 2 seconds for 10 minutes, and each nudge makes one `GetTask`. `sendMessage` returns the first task for a repeated `messageId` before any policy or limit check, and the route then blocks up to 90 seconds polling D1, so a peer with one working task can hold any number of those calls, none counted | Cost | Cap streams per connection, throttle nudges |
| N8 | Nit | `endConnection`, `decline`, `failInvite` and outbound `onConnectionRevoked` write several statements without `atomic`. The status checks and the sweep recover them, but the repo rule says otherwise | Repo rule | Move to `atomic` when next touched |
| N9 | Nit | `pairableAgent` hands out codes for a managed agent published earlier, and the connection then refuses every message | Pairing | Add a runtime check |
| N10 | Nit | `needs_approval` and `awaiting_peer` rows have no expiry once a join has used the invite | Connections | Expire them like invites |
| N11 | Nit | "Always allow" on a peer run's tool card writes an agent rule that applies to member runs and still doesn't stop the asks in that peer run. The card doesn't say so | Requests UI | Hide it on peer-run cards |
| N12 | Nit | `addOutbound` takes `seen` as optional, so only the page, not the API, guarantees the destination was compared. Session callers only | Credentials | Make it required when the scheme has a credential |
| N13 | Nit | A peer's answers to a question are outside the hourly limit, so one task on `auto` can drive model turns past it. Not a must-fix: the spec's row counts tasks, and one run at a time bounds it to one agent | Cost, loops | Scope below. Worth doing, because the spec calls the limit "the real backstop" |

## Traced paths

**Can a peer or an injected agent create, approve, widen or revive a connection, or reach beyond `a2a.*` and `runs.start`?** No. Every create, approve and widen method goes through `requireSession` (`via === "session"`) and `requireAdminOrOwner`. No MCP tool touches them. `can()` confines a peer principal to `a2a.*` and `runs.start`, and `runOperation` only calls `a2aTasks` methods. `authenticate` is keyed to the path's `publicId`, and the token isn't part of `createPrincipalResolver`. A revoked key can't be re-paired, because `requestPairing` and `approvePairingCode` both find its hash on the ended row. `activate` accepts only `awaiting_peer` and `active`. `answerAsPeer` takes only a `question` on a run this connection started.

**Does a revoke stop everything on the next request?** Mostly, with M3 as the exception.

| Thing | Result |
|---|---|
| Token | Stops. Re-read on every request, and open streams fail on their next read |
| Waiting tasks | Rejected |
| Task's own run | Cancelled |
| Hand-off runs and wake runs already started | Not stopped (M3). Their tools do ask, because `peerAsksEveryTool` asks on an ended connection, but they use model turns and hold their agents |
| Outbound sends | `dispatch` and `refresh` re-check the status. A call already in flight can't be recalled |
| Wakes | Refused, in the same statement as the claim |
| Pushes and outbox | Queued pushes are deleted, and `matters` checks the status again at delivery. A notice to the peer still goes, as designed |

**Does a credential go to a destination a person didn't see?** No path found. `safeFetch` and the in-process branch both refuse any 3xx. `destinationOf` compares the interface's origin with the approved `peerOrigin` at every send, and `credentialOf` compares the OAuth token URL with the approved label. Outbox rows are written with a URL from the approved card URL, and pushes carry only the peer's own credentials to the URL it named. A self-origin URL dispatches in-process with the same checks, and it grants a peer nothing it couldn't do from the internet. M4 means the card is never refreshed, which is safe for credentials: they keep going to the approved origin.

**Does `tool_policy = ask` hold on every path, and is managed refused?** For runs a peer started, and their hand-offs, yes. The cloud `beforeTool` and the daemon's `decide` both ask `needsApproval` per call. The daemon denies when the check fails, and the cloud caches only "asks". An old daemon can't claim a peer run, and "always allow" can't open the gate, because the peer check comes first. Both runtimes exempt the question tools, which `input_required` needs, and which N1 uses. Wakes are not gated, which is the decision in M1, and managed has a hole (M2).

**Can peers loop or run up cost?** Hops: a wake is a child, so it adds a level, and a run past `MAX_RUN_DEPTH` is refused. A peer can lie low about hops, as the spec expects. Tasks, sends and wakes all count in `hourlyCountSql`, inside the writing statement. Answers don't count (N13).

**Does the dev allowance stay out of production?** Yes. `allowLoopback` and `allowHttp` come only from `devFakeRuntime`, which every `compose` call sets from `import.meta.env.DEV` or `false`. Vite makes that `false` in any `vite build`, including `--mode staging`. `HM_STATE_DIR` only touches local state in `vite.config.ts`.

**Is the pairing path limited as the spec says?** Yes. It answers only `SendMessage`, with a token of at least 32 characters, on an agent that is published, active, open and not locked. REST never reads the body, and JSON-RPC reads only the envelope, up to 256 KB. Message text isn't stored. Writes are bounded by the three slots, including the event. Every refusal is the same 401, so an agent with pairing off can't be told from one that doesn't exist. With pairing on, a caller who has the public id learns only what the public card already shows. Limits match: 8 characters, hashed, 1 hour, 3 pending, same token gets the same code, lock after 5 wrong codes. See N4 and N9 for the small gaps.

## N1: one run at a time, judged

It is worse than the AA.8 line says, and it isn't a security hole.

- **Which runs hold the agent.** The claim refuses while any run of the agent is `running` or `waiting`, and a `waiting` run can be on a question (`QUESTION_TTL_MS`, 24 hours) or on a tool approval (`APPROVAL_TTL_MS`, 1 hour per call). So the default `tool_policy = ask` holds the agent too, up to an hour per tool call, with no malice and nobody at the desk.
- **Expiry doesn't free it for good.** The spec's "until someone answers or cancels" isn't quite right: at 24 hours the question expires and the run resumes. The model can simply ask again, and if the run ends, the peer sends one more message.
- **Can a peer block indefinitely?** Yes, at `inbound_policy = auto`, for about one message a day. The hourly limit never sees it, and question tools are exempt from `tool_policy`, so nobody is asked. At `approve`, a person has to approve the message that starts each block, but then the same 24 hours applies.
- **Starving without a question.** The queue is oldest first, so an `auto` peer sending 20 tasks an hour can keep work queued ahead of members, Slack and triggers, whenever each run takes longer than three minutes.
- **What limits it.** A person has to have created the connection, the blast radius is one agent, and any member can revoke or cancel in one click, which clears the hold at once. The question shows in Needs you.

The spec lists a cap under "Not in this build", so by the gate's definition this is not a must-fix. My advice to Dom: don't put an `auto` peer on an agent that does other work until there is a cap. The smallest useful fix is a shorter `ttlMs` on a question from a peer-rooted run (1 hour; `requests.open` already takes one), and failing the task when it expires instead of letting the run ask again.

## The 4 open TCK failures, judged

All four reasons hold. I read the requirement text and the tests at the pinned commit d4d6fae7, cloned to `tmp/AA-gate/a2a-tck-d4d6fae7`.

- **DM-ART-001 (MUST), holds.** The requirement says an Artifact must contain `artifactId` and `parts`. Ours does, and the text artifact test passes. The six failures come from `test_task_has_file_artifact`, `test_task_has_file_url_artifact` and `test_task_has_data_artifact`, on both bindings, which send the scenario prefixes `tck-artifact-file`, `-file-url` and `-data` and fail when no artifact of that type returns. That tests what a TCK-built agent does for a prefix, not what the spec requires of an Artifact. Our card declares `defaultOutputModes: ["text/plain"]`, and the spec's "text out" decision covers it. These tests stay red for any agent that doesn't make files.
- **DM-MSG-001 (MUST), holds.** The requirement says a Message must contain `role`, `parts` and `messageId`. Every Message we emit has them (`agentMessage`, `userMessage`, the pairing reply). The two failures are `test_returns_message_with_text_part`, whose scenario "Return message instead of task" expects a direct `Message`. An agent may answer `SendMessage` with either, so a Task-only server can't pass it. The test files this behaviour under the wrong requirement.
- **CORE-SEND-003 (MUST), holds, with N5.** The requirement block declares no `expected_error`, and its sample is a `raw` part, so the record's reading fits. I read the requirement and the helper that needs `expected_error`, not the generic runner's code path. Our answer to that sample is the right one, and reporting it upstream is still worth doing. The requirement's wording is about media types, which is where N5 is a real but small gap.
- **CARD-CACHE-003 (MAY), holds.** A MAY, with `ETag` and `Cache-Control` present.

## Must-fix scopes

### M1: a wake run keeps the person's delegation

Spec: "What the agent sees": "Runs have `onBehalfOfUserId = null`, so user-mode connector credentials aren't available, the same as a trigger run."

Failing scenario, reproduced: a member asks agent X something that makes it message outside agent B, with every setting on its default. The member's run ends. B answers with text written to steer X. `wake` starts a run with B's text as its input, through `subjectOfRun`, which copies the parent's person: the run has `actor: agent` and `onBehalfOfUserId: u-member`. So a peer's text drives a run that holds that member's user-mode connector credentials, with nobody present.

Scope:

- `startWakeRun` in `packages/services/src/a2a/outbound.ts` starts its run with `onBehalfOfUserId: null`, keeping `parentRunId` and depth from the calling run. That needs a way through `deriveSubject` in `runs/subject.ts` that a peer's request can't reach.
- Anything a wake inherited from the person's delegation that needs a person (attached files, say) is refused the normal way for a run with no person.

Check: a new test that a wake has `onBehalfOfUserId` null whether a member, a trigger or a peer started the calling run, and that a connector in user mode finds no credential in that run. The test "F1b" in `tmp/AA-gate/repro/gate.test.ts` passes.

**Decision for Dom: does `tool_policy` gate a wake?** Today it doesn't. In the same scenario `needsApproval` for `bash` answers `false`, because `peerRootOf` walks up to a member's run and returns null. X runs with its full tools and its normal rules, which on a machine agent means shell, and a daemon without `currentApprovals` can claim it. The spec doesn't settle this. Its row says "In a run this connection started", its gate section names "a run a peer started and any run that run handed work to", and the comment on `startWakeRun` assumes the chain handles it. Gating every wake changes what people see on every outbound connection: a member asks X to ask B, B answers, and X now asks a person for each tool.

My recommendation is to gate it. The spec's reason for the default is that "a remote message is prompt input to an agent that may hold shell access and credentials", and a wake is the one case where that input arrives with nobody watching. A person who trusts the peer has `agent_rules` for this. If Dom agrees:

- The wake's actor becomes `{ kind: "peer", id: connection.id }`.
- `peerAsksEveryTool` in `requests.ts` walks the whole chain and asks if any peer link asks or has ended, so a wake on an `agent_rules` connection under a run started on an `ask` connection still asks.
- `answerAsPeer` stays unable to answer a wake's question, since no task links to it.
- The wake paragraph in the spec says so.
- Check: in `tool-gate.test.ts`, a wake on a default connection has `needsApproval` true for any tool key, one on `agent_rules` follows the agent's rules, the mixed chain above asks, and a daemon without `currentApprovals` can't claim a wake. The test "F1" in the repro passes.

### M2: a managed agent can be woken with a peer's text

Spec: "The managed runtime doesn't call `needsApproval`, so it can't be gated. Agents on that runtime can't be published, a message to one published earlier is refused, and a run a peer's text set going can't hand work to one."

Failing scenario, reproduced: `publish` refuses a managed agent, but `addOutbound` needs no publication and doesn't look at the runtime. Its run can use `send_message`. When the answer comes after the run ends, `refusePeerHandoffToManaged` sees a wake whose principal isn't a peer and whose parent isn't peer-rooted, so a queued run on the managed runtime gets the peer's text with no gate of any kind. The same happens to an agent moved to managed after connecting.

Scope:

- `refusePeerHandoffToManaged` in `runs.ts` refuses a wake, through an explicit start option from `startWakeRun`, so this doesn't depend on the decision in M1. `settleFailedWake` already treats that as permanent, and the answer stays readable.
- `addOutbound` refuses a managed agent, in the words `publish` uses.
- `outbound.admit` refuses a run on a managed agent, for an agent moved after connecting, because `get_run` in its live run would otherwise read the peer's text ungated.

Check: tests that `addOutbound` on a managed agent is refused, that `send` from a run of an agent moved to managed is refused, and that a pending result on an agent moved to managed starts no run and logs `woke: false`. Test F2 in the repro passes.

### M3: revoke leaves hand-off runs alive

Spec: "rejects tasks waiting on approval and cancels runs in flight for that connection". The brief's question: does it stop running runs?

Failing scenario, reproduced: a peer run hands work to a colleague through `send_message`. A member revokes. The parent is cancelled, and the child stays `queued`, then gets claimed, runs, uses model turns and holds its agent. `cancelRun` cancels one run and doesn't touch children. `a2aTasks.onConnectionRevoked` and the sweep only look at runs linked to a task. Tools in those runs do ask, so this is cost and a held agent, not unattended action. A wake run in flight has the same gap.

Scope:

- `onConnectionRevoked` in `a2a/tasks.ts` also cancels every live run whose chain reaches this connection: hand-offs of its runs, and wakes, which are found through `request_id` `a2a-wake:<task id>` on this connection's outbound tasks. Include descendants of a parent that has ended, because a hand-off can outlive its parent.
- The sweep does the same, so a revoke hook that failed part way gets finished. Keep each batch bounded.
- Stay out of `runs.cancelRun` itself: a general cascade would change what a person's cancel does elsewhere.

Check: tests that after a revoke, a queued and a running child are `cancelled`, a grandchild too, a child whose parent had already ended too, and a run of an unrelated connection is untouched. After a revoke whose hook is made to fail, the sweep gets there. Test F3 in the repro passes.

### M4: `refreshCard` has no caller

Spec: "A refreshed card whose interface moves to another origin puts the connection back in `needs_approval`."

Failing scenario, confirmed by search: `refreshCard` appears only in `connections.ts` and its test. There is no tRPC procedure, tick job or button, although its comment says "a person or the minute tick". A peer whose card moves to another origin stays `active` with the old card for good. Nobody is asked, `peer_card_fetched_at` never changes, and `approveNewOrigin`, the page's pending origin display and `a2a.connection_reapproval_needed` can't be reached in production. AA.2 spent four review rounds on this path. Credentials stay safe, because they keep going to the approved origin. A peer that moved simply stops working, with no way to recover but removing and re-adding it.

Scope:

- `a2a-router.ts`: a `refreshCard` procedure, with a Refresh button on the connection's detail page for an `a2a_outbound` row.
- `tick/a2a.ts`: a bounded job refreshing active outbound connections whose `peer_card_fetched_at` is older than a day, oldest first. A fetch that fails changes nothing. Needs no new index beyond what the batch needs, and one peer's failure must not stop the batch.
- `desk.railSources` already lists `needs_approval`, so a moved card reaches Needs you. Confirm it with a test.
- First fix the round 5 nit on the `refreshCard` write in `docs/reviews/tasks/AA.2.md`: match `peerCard` in the WHERE too. A tick makes those overlaps real.

Check: tests that the procedure refuses a non-session principal, that a tick after a day flips a moved card to `needs_approval` and sends nothing further, that an unchanged card stays `active` with a new `peer_card_fetched_at`, that a card fetch failure leaves the row as it was, and a tick and a person overlapping log once.

## N13: scope for answers and the hourly limit

Scenario, from the code: a connection on `auto` with `hourly_limit = 1`. The peer sends one message telling the agent to ask for its next instruction with the question tool after each step. `continueTask` calls neither `admit` nor `enforceHourlyLimit`, and question tools skip the gate, so the peer answers as often as the agent asks. Each answer is a model turn and nobody is asked. The limit stays at 1 of 1 used and never fires.

Scope:

- `a2a_answer_markers` already has `connection_id` and `created_at`. Add them to `hourlyCountSql` and `hourlyUse` in `a2a/hourly.ts`.
- `continueTask` checks the limit, inside `claimAnswer`'s insert as the others do it, and answers 429 with `Retry-After`. A retry of a recorded answer still returns the task first.
- Say so in the spec's `hourly_limit` row.

Check: tests that with limit N, the answer that passes N gets `A2aRateLimitError`, leaves the question open and writes no marker, that a retried message id still returns the task, and that two answers at once can't both take the last place. A route test sees 429 and `Retry-After` on both bindings.

## Not looked at closely

UI rendering of the connections page beyond what the flows above need, the Hermes script's internals, and migration SQL beyond confirming that 0036 and 0037 don't touch `events`, drop tables or set pragmas. The in-flight behaviour of `cancelRun` on each runtime is existing code that I took as it stands.
