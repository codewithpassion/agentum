# RT.2 review: Move an agent to another runtime

## Verdicts

Round 1 (ca6b061): not clean, one must-fix. Moving cloud to managed and back to cloud resumes the old Cloudflare conversation, because the cloud Durable Object (keyed by session id) keeps it and clearing `sessions.runtimeRef` does not touch it.

Round 2 (87abba9): clean. The reviewer accepted a dialog note in place of a Durable Object reset: moving to Cloudflare says an earlier Cloudflare conversation may be picked up again. The 87abba9 fixes also cover the round 1 nits below.

## Known gap against the task text

The task says a move starts conversations fresh. That holds for managed and machine targets (the runtime ref and the managed session are cleared). It does not hold when moving back to Cloudflare: the `PiRun` Durable Object keeps its conversation. The staging check (Cloudflare to managed and back, one task each time) should expect the old Cloudflare conversation to come back.

## Nits left

- The machine list in the dialog can preselect the agent's current machine, which the server then refuses with "already runs on machine".
- The "computer is detached" note shows even when the agent has no computer, and the Cloudflare note shows for an agent that never ran there.
- The live-run check runs before the `atomic` write and the write has no guard, so a run queued in between is not refused.
- The service reads `workspaceAnthropicKeys` and the managed tables directly and imports `NO_KEY_MESSAGE`, and `dropVaults` in `compose.ts` repeats the gateway setup of the managed service. Closing sessions belongs in the managed service.
- `atomic` is optional on `createAgentsService`, so a missing port shows only when a move is tried.
- "Move agent" shows to every member. Only the owner or an admin can use it, so others get a forbidden error.

## Ideas beyond the scope

- A `forget(sessionId)` call on the `PiRun` port (`pi-run-port.ts`) that clears the conversation, called from `changeRuntime` when the agent leaves cloud. That would make the "starts fresh" promise true for the round trip. It runs under Miniflare in `vite dev`, so it can be tested locally.

## Not verified

- The staging check: move a test agent Cloudflare to managed and back, run one task each time (the controller runs it).
- The dialog in a real browser. Covered by logic tests and a static render test only.
- `bun run typecheck` in `apps/web` runs out of memory at the default Node heap, on this branch and on main alike. The checks here ran with `NODE_OPTIONS=--max-old-space-size=8192`.

## Steps for Dom

None needed from accounts or dashboards. The staging check needs a workspace with an Anthropic key.
