# TX.3 review

## Verdict

Round 1, commit 2463b258: must-fix. Nothing timed out the lead's checkpoint, so a lead whose wake was refused or whose run ended without posting held the discussion open until a person pressed Stop. While a discussion ran, every post in the topic, a person's @mention included, was swallowed by the discussion drive and woke nobody.
Round 2, commit 528ba28b: must-fix. The new round expiry closed a discussion even while the lead's checkpoint run was still queued, running or waiting, which lost the lead's late reply.
Round 3, commit 193a67e7: clean. No must-fix findings.

The fixes: a round that the lead has not answered ends the discussion after twice the ten-minute window, measured from the round's opening, but only once the checkpoint run has ended without posting (or never started). A person's post inside a discussion drives the rounds and wakes its mentions as usual. Agent posts only drive the rounds.

## Decisions made

- Participants are the active agent members of the lead's team who can read the topic, minus the lead. They are written into the question post as profile links on a final `Participants:` line, and the roster stays fixed for the discussion.
- Each member wake and each lead checkpoint wake carries its own run retry key, `discussion:<id>:<round>:<agentId>`, so a round wakes a member at most once and the budget (rounds times members) cannot be exceeded. Discussion wakes run as the system principal, in the shared inbox session, so they get no private notes under the one rule in `packages/services/src/library/private-notes.ts` (ME.14). A test asserts it for all nine member wakes.
- The lead's reply to its checkpoint opens the next round, or closes the discussion on the last round. A reply starting with `/close` closes early.
- A member's post counts once per round. The insert is a single `INSERT ... SELECT ... WHERE NOT EXISTS` through `atomic`.
- Discussion wakes count their hourly limit across inbox and Q&A wakes. Ordinary room wakes are unchanged.
- A person stops a discussion with `inbox.stopDiscussion`, which the room's Stop discussion button calls. Stop only flips the status. Runs already in flight finish.
- `discussions` has no round-opened column, so the ten-minute rule reads the round's opening post time.

## Nits left

- A refused or over-budget member wake is retried on every drive until the round times out, with a new `inbox.loop_stopped` event each time. Bounded at about ten minutes.
- The `discussion:` request-id prefix is not reserved the way `question-answer:` is in `runs/pause-hold.ts`, so an agent can pass such a requestId through `send_message`.
- The waker for member wakes is a made-up user principal built from `thread.createdBy`, which holds the lead's agent id for a topic a lead opened. Stop events can be credited to the wrong actor.
- When the once-per-round insert is skipped, `lastPostAt` is still updated, and the agent is handed the earlier post as if its second post had landed.
- Stop posts nothing and records no event of who stopped it.
- An error that is not a `ServiceError` in one discussion aborts the rest of that sweep tick.
- No service-level test for rounds outside 1 to 5 or for a non-lead agent starting a discussion. The MCP tool test and the schema cover them.
- If the lead asks a person a question during its checkpoint, the discussion can stay open up to a day. A person can press Stop sooner.

## Ideas beyond the scope

- Post a short line in the room when a discussion ends, whether by close, timeout or Stop.
- Let a person extend or shorten a running discussion.

## For Dom

Nothing. No migration, secret or dashboard step. The per-minute tick already sweeps discussions.
