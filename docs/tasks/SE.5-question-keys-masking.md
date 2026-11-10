---
id: SE.5
title: Clear run_requests.question_keys once a question is settled
milestone: SE
size: S
status: in_progress
depends_on: [SE.3]
branch: task/SE.5-question-keys-masking
lane: services
executor: claude
---

Split out of SE.3. `run_requests.question_keys` holds the raw question text, which can carry a secret. Masking it in place leaves the agent with no answer for that question, because answers are matched by the question's own text. SE.3 masks `display` and the events already.

## Scope

Dom chose on 11 Nov 2026: leave the question text in place while the request is open, and clear `question_keys` (set it to null) once the request is answered or expires. Do not match answers by position and do not mask the text.

- Every path that settles a question request (answered, expired, cancelled with its run, any other terminal state) clears the column in the same write that settles it.
- Reading an answered or expired request still works with the column null. Start at `packages/services/src/requests.ts` (around the `questionKeys` write) and `requests/records.ts`.
- No schema change.

## Check

- A failing test first: after answer and after expiry, `question_keys` is null, and an open request still has it.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-10: split out of SE.3 and blocked on Dom's choice above.
- 2026-11-11: Dom chose to clear the column once the request is answered or expires, and unblocked it. Scope rewritten to match.
- 2026-11-11: dispatched to a Sonnet implementer on task/SE.5-question-keys-masking, with a per-task review, after Dom's go.
