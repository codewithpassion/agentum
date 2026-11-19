---
id: NV.4
title: "A waiting question no longer holds the machine lane"
milestone: NV
size: M
status: todo
depends_on: []
branch: null
lane: daemon
executor: claude
---

From `docs/v4/build-plan.md`, milestone NV. Found on 18 Nov (`docs/analysis/small-agent-teams.md`). `apps/agentum/src/approvals.rs` long-polls until a request closes. A question lives 24 hours (`QUESTION_TTL_MS`), and a machine runs one run per agent, so one unanswered question stops that agent for a day. On the Roster that agent would look stuck with no reason.

## Scope

- For `kind: question`, end the turn with a tool result that says the answer will arrive later. Keep approvals synchronous, since they expire in an hour.
- When the question is answered, start a follow-up run in the same session with the answer as input, the way `claude.rs` already resumes a session.
- The run's status is `waiting` while the question is open, and the agent can take other runs meanwhile.
- Server side lives in `packages/services/src/requests.ts` and `runs/`; the answer path wakes the session once, also when answered from Slack.

## Check

- `cd apps/agentum && cargo test` passes with a test for the early return on a question.
- Service test: answering a question on a machine agent creates exactly one follow-up run in the same session, and a second answer creates none.
- Local run with the fake runtime: ask, start a second task while the first waits, answer, see the first continue.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
