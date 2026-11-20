# SP.3 review

## Verdict

Round 1, commit 9ebdd4bf: must-fix. Runs queued before the pause were still claimed after it, and the `spend_pause` card showed to every member.
Round 2, commit 4c63b98d: must-fix. A caller could pick a request id that borrowed the hold's exemption, the managed runtime's claim had no hold, and a held older run blocked the follow-up queued behind it.
Round 3, commit bea7ffa7: must-fix. The reserved-id check was case-sensitive while the SQL `like` is not, and `startForGuest` skipped it.
Round 4, commit f603eb31: clean. No must-fix findings.

## What it does

`spend.enforceCap` runs when a run finishes (and when a turn parks on a question). An agent over its weekly cap is paused (`paused_at`, reason `spend_cap`). A workspace over its cap pauses every active agent. A paused agent refuses a start from every origin with `agentPaused` (a `conflict` with reason `agent_paused` and a plain message). The follow-ups of work under way still start: a parked run's answer, a child's wake, a subagent. A run queued before the pause is held at every claim (`claimRun`, the machine claim, the managed claim) until the agent is resumed. `startRun` and `startForGuest` refuse a caller-chosen request id that starts with `question-answer:` or `handoff-wake:` (any case), because the hold exempts those. The `spend_pause` Needs you card is derived from agents with `paused_reason = 'spend_cap'`, shown to the owner (else creator) and org admins, and gone after resume. `spend.setCap`, `spend.resume` and `spend.caps` are implemented. Roster shows a paused agent as `stopped`, "Paused. Weekly limit reached", and now carries `weeklyCapCents`.

Origins: Slack mention and DM get a thread reply once per event; the Slack batch waits quietly. Mail gets one reply per thread per pause. A routine skips the slot (no run, no failure count, new `skipped` list). An A2A task fails with "This agent is paused.". Inbox, Q&A, tRPC, MCP and triggers return the conflict, which they already treat as a refusal.

Decisions made where the task was silent: setCap, resume and caps were SP.1 stubs, so SP.3 fills them (SP.4's UI needs them). Who may set a cap: a browser session only (never an agent, key or app), an agent's cap by its owner or an org admin, the workspace cap by an org admin. `AgentRecord` gained `pausedAt`.

## Nits left

- Dream (DR.4) is not gated, because the dream run does not exist yet. DR.4 must skip a paused agent (`agent.pausedAt !== null`, status `skipped`).
- A held run that reaches the one-hour unclaimed expiry fails with "Never claimed". The Slack or mail sender is not told it was the pause.
- An A2A wake of a paused agent (`wakeOf`) is refused and retried each tick, with a log line, for up to a day, so it runs after a resume inside that time.
- A non-admin owner can resume an agent the workspace cap paused. It gets one more run, then `enforceCap` pauses it again. Raising the workspace cap does not resume agents; each is resumed on its own.
- A workspace-cap pause and an agent-cap pause read the same on the card.
- Mail notice: it goes to any sender who passes the auto-submitted and list filters, so a forged From gets one reply per thread. The task asks for the reply. The notice is skipped when any outbound message in the thread is newer than the pause.
- A Slack mention to a paused agent is not stored for later, so the agent does not see it after resume.
- A paused agent that is still finishing a run shows `stopped` on the roster.
- A skipped routine slot leaves no event.
- `enforceCap` runs before `deliverReply`, adding two reads to each finished run.
- Tests: the hold is tested through `claimRun` only, not the machine or managed claim. A biome-ignore reason says "two calls" for a loop of three.
- The reserved-id refusal in `startForGuest` runs before the availability check, so a guest sending such an id gets `invalid`, not `guestUnavailable`.

## Beyond the scope

- SP.4 must hide the cap field and Resume button from members who are not the agent's owner or an admin, and the workspace cap from non-admins; the service answers Forbidden.
- DR.4 (dream run) needs the pause check above.
- A pause could append an event for the activity log. None exists.

## Test notes

- `bun run check` and `bun run test` pass at f603eb31. The first full test run after the change to `AgentRecord` needed a one-line fixture fix in `apps/web` (`pausedAt: null`).

## Steps for Dom

None. There is no migration.
