---
id: SL.12
title: "Always allow is for the agent's owner"
milestone: SL
size: S
status: done
depends_on: []
branch: task/SL.12-always-allow-is-for-the-agent-s-owner
lane: services-requests
executor: claude
---

From the SL gate review, round 1 (`docs/reviews/SL-1.md`, must-fix 3).

## Scope

- In `requests.answer`, an `always_allow` decision from a person who is not the agent's owner and not an admin fails before the request closes, with the message "Only the agent's owner can always allow this. Allow it once instead." Keep "any member can answer any request" for allow once and deny.
- The Slack card path shows that message as an ephemeral reply and leaves the card open. The button stays on the card for everyone, because Slack cannot hide a button per viewer.
- `principalOf` in `slack/requests.ts` builds the Slack principal with no `isAdmin`, so an admin who does not own the agent is refused in Slack. That is the default. They can still always allow from the web.
- `putRule` callers other than `setRule` get the same guard, so the bypass cannot come back.

## Check

- `requests.test.ts`: a member who does not own the agent sends `always_allow`. It is refused, the request stays open and no rule is written. The owner and an admin succeed.
- A flow test: a linked non-owner presses Always allow on a room card in the fake Slack. They get the ephemeral refusal, no rule is written, and the card stays open.
- `bun run check && bun run test && bun run build` pass.

## Controller decisions

- An admin who does not own the agent is refused Always allow in Slack and can still use it from the web.

## Log
- 2026-11-21: added by controller.
- 2026-11-21: dispatched.
- 2026-11-21: ready at 2af8e6dc after one fix round, review clean. The guard sits in requests.answer, so an admin's Always allow still works by mail. Queued for merge.
- 2026-11-21: merged d895ba73, batch merge check with DR.16, DR.12 and SL.12 passed. Done.
