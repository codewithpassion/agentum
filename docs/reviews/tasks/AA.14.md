# AA.14 review record

Gate 1: a peer-rooted run can't request a human takeover. Follows the idea in `docs/reviews/tasks/AA.13.md`. Spec: `docs/v3/agent-connections.md`.

## Rounds

- Round 1, at 03d0679d: clean, no must-fix, 12 nits. No fix round ran. The reviewer's `bun run test` and `bun run build` were cut short by a SIGTERM, so the dispatcher's own full run (`bun run check`, `bun run test`, `bun run build`, all passing, no `drizzle` in `apps/web/dist/client`) is the record for them. The spec paragraph was reworded after the review (the "on every runtime" overstatement and the repeated sentence).

## What changed

- `requests.open` refuses a `takeover` for a run whose chain reaches a peer (`peerRootsOf`: a run a peer started, a hand-off, a wake), before the computer check. It throws a `conflict` `ServiceError`, writes no request and leaves the run running.
- On the cloud runtime `request_human_takeover` (`pi-run-gate.ts`) turns a `ServiceError` from `open` into an error result, as the managed runtime already did, so the run carries on.
- Spec: one paragraph under "What the agent sees".
- Tests: a peer's run, a hand-off of it and a wake are refused with no request and the run still running, and a member's run still opens (`tool-gate.test.ts`). The gate returns the refusal as a result (`pi-run-gate.test.ts`).

## Nits left

- The cloud gate's catch takes every `ServiceError` from `open`, so a member run's "no computer" or "already pending" now comes back as a result and not a thrown failure. That includes "Run is not running" and `not_found`.
- The refusal sentence is a copy of the one in `managed/service.ts`. `.catch` plus an `if` could be a plain try/catch.
- The comment at `managed/service.ts:1144` names two refusals, `open` now has a third.
- A peer-rooted takeover already pending when this deploys is returned by the idempotent check and can hold the agent until it expires.
- Machine runs can't open a takeover at all (`routes/machine-runs.ts` accepts approvals and questions only).
- Tests: `REFUSED` checks the code and not the message, the hand-off test sets `parentRunId` by hand, and no test shows a non-`ServiceError` is rethrown or joins the real refusal to the tool result.
- Peer-rooted runs are still offered the tool and spend a model call on the refusal.

## Ideas beyond the scope

- Leave `request_human_takeover` out of the tool list for a peer-rooted run.

## Steps for Dom

None that need an account or a dashboard.
