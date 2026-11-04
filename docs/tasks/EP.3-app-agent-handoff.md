---
id: EP.3
title: Hand-off from app code to an agent, and replies back to the app
milestone: EP
size: L
status: todo
depends_on: [EP.1]
branch: null
lane: services
executor: claude
---

Spec: `docs/v3/app-endpoints.md`, section "Hand-off to an agent".

## Scope
- Approving an `agent` grant makes a tokenless, enabled trigger row for that agent with `artifact_id` set, or reuses the one for (artifact, agent). Revoking the grant, or a version that drops it, leaves the trigger paused.
- `env.AGENTUM.startRun({ agent, text, state?, sessionKey? })` on an `endpoint` viewer only. It needs an approved `agent` grant on the live version and an enabled trigger, and fires through the triggers service as that trigger principal without waiting. Reply target `{ kind: "app", artifactId, state }`. `sessionKey` maps to the session's external key. Returns `{ runId }`. Every other viewer is refused with `forbidden`.
- An `app` gateway registered in `compose.ts`. `deliver` invokes the live version's `reply` export through the harness (`modules.ts`) with the viewer `{ kind: "reply", runId }` and `{ runId, status: "finished", text, fileIds, state }`. Failed, cancelled and interrupted runs are delivered with their status from the runs event hook, as `a2a/tasks.ts` follows run events. A version without a `reply` export is skipped. A failure writes an `app.reply_failed` event and is not retried.
- `compose` takes an optional `exports` (the Worker's `ctx.exports`). Every caller that can finish a run passes it: the request handler in `server.ts`, `pi-run.ts`, `managed-poller.ts`, `vm-session.ts` and any other the grep finds. Without it, the gateway writes `app.reply_failed`.
- The reply viewer has the endpoint viewer's rights minus `startRun`.

## Check
- Tests:
  - `startRun` is refused without the grant, with a paused trigger, and on member, link, test and reply viewers;
  - it starts a run on behalf of nobody with the app reply target and `state` kept;
  - a finished run calls `reply` with the text and state, and a failed run calls it with `status: "failed"`;
  - a version without `reply` is skipped;
  - a throwing `reply` writes `app.reply_failed`.
- A test asserts each run-finishing context passes `exports`.
- End to end in local dev with the dev fake runtime: an endpoint request hands off, the run finishes, and `reply` writes to shared storage, which the test reads back.
- `bun run check && bun run test && bun run build` pass.

## Log
