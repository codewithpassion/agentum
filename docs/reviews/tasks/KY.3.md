# KY.3 review

## Verdict

Round 1, commit 70b43e9a: one must-fix raised, then downgraded to a nit by the dispatcher, so the verdict is clean after 0 fix rounds. The reviewer said "not clean" only because of finding 1 and called the rest clean.

The must-fix: a member can still set or replace an agent's credential (`setCredential` with `agentId`, and OAuth `start` with an agent owner). The task scope names only "the caller's own credential" as open to members, and an agent's credential is not another person's. Before this task any member could do it, and the agent profile connectors sheet relies on that. Tightening it would change that flow without the task asking for it, so it stays open. The controller can raise it as its own task.

## What changed

- `requireAdminSession` in `guards.ts` now guards connector create, setAuthMode, setCallTimeout, remove (session branch) and OAuth setClient. Before, these checked only a signed-in session, and the Settings UI was the only gate. The admin API key branch of remove is unchanged.
- `connectors.mine` returns one entry per workspace connector with the caller's own credential and a `shared` flag. `connectors.removeCredential` deletes only the caller's user-owned credential and their pending OAuth flows, and returns `{ removed: false }` when there is none.

## Nits left

- `settings.connectors.tsx`: no guard keeps members out of Settings. Add, Auth, Time limit, Delete and Set client now fail with Forbidden for a member. KY.5 and KY.6 move the member path to Keys and "Your sign-ins".
- `connectors.ts` (removeCredential comment): the claim that replacement writes are fenced covers refresh and paste, not OAuth `complete`. That path deletes its state row first, exchanges the code, then inserts the credential, so a disconnect during the exchange is undone.
- `connectors.ts`: after the last credential is removed the connector `status` stays `ok`, so `mine` can report `status: "ok"` with `myCredential: null`. The UI must read `myCredential`, not `status`.
- `credential.revoked` is appended after the atomic delete, not inside it. This matches `connector.deleted` and `credential.created`.

## Beyond the scope

- Decide who may set an agent's credential (agent owner or admin) in a follow-up.
- Codex resolved these ambiguities: an absent credential returns `{ removed: false }`, and disconnect leaves active runs running.

## Test notes

- `bun run test` fails on this host for reasons outside this task: the Rust test `the_session_bus_listens_where_the_environment_says`, and the flaky `live-artifacts/guest-execution.test.ts` (timed out inside the full run, passed alone on the second try, 100 s).

## Steps for Dom

None.
