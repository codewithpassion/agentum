---
id: SE.5
title: Mask secrets in run_requests.question_keys
milestone: SE
size: S
status: blocked
depends_on: [SE.3]
branch: null
lane: services
executor: claude
---

Split out of SE.3. `run_requests.question_keys` holds the raw question text, which can carry a secret. Masking it in place leaves the agent with no answer for that question, because answers are matched by the question's own text. SE.3 masks `display` and the events already.

## Scope

Waits on Dom's choice: leave it as is, clear the column once the request is answered or expired, or match answers by position and mask the text.

## Check

- A failing test first for the chosen behaviour.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-10: split out of SE.3 and blocked on Dom's choice above.
