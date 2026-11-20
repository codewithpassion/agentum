---
id: TX.4
title: "Decision queue: several questions in one request"
milestone: TX
size: M
status: in_progress
depends_on: [TX.1]
branch: task/TX.4-decision-queue-service
lane: services-requests
executor: claude
---

From `docs/v4/build-plan.md`, milestone TX. From the transcript: the lead queues several decisions as one questionnaire. Files: `packages/services/src/requests.ts`, `requests/`.

## Scope

- Tool `ask_decisions(questions)` for any agent: up to eight questions, each with two to four options and an optional free-text choice.
- A person can answer some questions and leave others. The request closes when all are answered or it expires after 24 hours. `dismissDecisions` hides the card and the agent can raise it again.
- Answers return to the agent as plain text, one line per question, by the follow-up path from NV.4 so the agent is never parked.
- The item reaches `desk.railSources` as kind `decisions`.

## Check

- Service tests: partial answers, close on last answer, dismiss and re-raise, expiry, the follow-up run carries the answers.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-11-19: written from the 19 Nov UI rethink and Dom's decisions of that day.
- 2026-11-20: dispatched on task/TX.4-decision-queue-service (v4 controller session).
