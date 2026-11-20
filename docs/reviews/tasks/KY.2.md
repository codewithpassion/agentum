# KY.2 review

## Verdict

Round 1, commit df0e7c4c: clean. No must-fix findings.

## Nits left

- `keys.ts`: an app with `authKind: "none"` returns `signIn: null` and `hasOwnSignIn: false`. The service never reads `connectors.authKind`. The Keys tab (KY.5) must not read `null` as "sign in needed" for such apps, or the service should expose the auth kind.
- `keys.ts`: the mailbox query has no status filter, so a failed or disabled mailbox still shows as the agent's address. Only `provisioning` is excluded.
- `keys.ts`: when the people lookup fails, every other sign-in shows as "Someone". No test covers that fallback.
- `keys.ts`: other people's sign-ins sort by Clerk user id, not by name, and sign-ins from people who left the workspace are still listed.
- `keys.test.ts`: no test seeds credentials on a connector the agent doesn't use, so the connector filter is never exercised. No test covers a same-workspace non-person principal (run or agent), the `ne(agents.id, agentId)` exclusion in `handsTo`, or removal of the member-only credentials filter.

## Beyond the scope

- Codex resolved these ambiguities in code comments: reads are person-only, `user_or_agent` and `user` never fall back to the agent's credential (matches `credentials.resolve`), only active handoffs count, the first non-revoked Slack app is shown, and all A2A connection states are kept.

## Test notes

- `bun run test` can fail on this host for reasons outside this task: the Rust test `the_session_bus_listens_where_the_environment_says` (D-Bus path length) and the flaky `live-artifacts/guest-execution.test.ts`. Both are recorded in earlier reviews. The full check passed on this branch.

## Steps for Dom

None.
