# KY.7 review record

Task KY.7, Keys walkthrough. Walkthrough findings: `docs/reviews/KY-e2e.md`. Browser proof: `docs/reviews/tasks/KY.7/browser.md` with screenshots (round 1 numbered 1 to 12, round 2 from 13).

## Verdicts

- Browser round 1 (fresh verifier, commit 06de983a): FAIL. Steps 1 to 4 pass at both sizes. Step 5 cannot be walked because the fake runtime never calls a tool. The phone task page overflows (424 px).
- Code review round 1 (991dc7d5): not clean, one must-fix. KY-e2e.md claimed a browser check of the four small fixes that had not happened. Fixed by running a browser round 2 and rewording.
- Browser round 2 (fresh verifier, 991dc7d5): the four fixes work at both sizes and the flow re-walks clean. Verdict FAIL for the same two reasons only: step 5, and the phone task page overflow.
- Code review round 2 (1b1cdd65, fix commit only): clean after 1 fix round.

## Nits left

- Settings, Apps shows no Connect for an OAuth connector with no stored settings yet (same gap as the fixed Your sign-ins one).
- A row set to "Its own" for an OAuth app that cannot register a client shows no control and no note.
- The select hiding for apps that need no sign-in keys on the member's connector, so it shows until that has loaded.
- Round 1 findings 5 (status badge says "Ready" beside "You have not signed in yet."), 10 (no Disconnect on the Keys tab), 11 (Find ranking of "sign-ins"), 13 (unlabeled Browser switch).

## Beyond the scope

Proposed tasks in KY-e2e.md: a fake runtime that calls a connector tool (KY.9), who may change an agent's apps (KY.10, needs a decision), allowed tools for an unconnected catalogue app (KY.11), the catalogue on Settings, Apps (KY.12, needs a decision), and the phone overflow on the task page (after RH.6).

## Test run on the branch

`bun run check` and `bun run build` pass. `bun run test` fails only in `@repo/services` "an hour of never-claimed runs stays bounded..." (passes alone, 52 s) and `web` guest-execution.test.ts (fails alone too, the known FX.1 flake).

## Steps for Dom

- Decide KY.10 and KY.12.
- After deploy, connect one catalogue app on staging as a member (Keys tab and Your sign-ins) with a real vendor account.
