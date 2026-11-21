# SP milestone gate, round 2

This review covers commit 72739bcc on origin/main, diff `sp-start..72739bcc`. I judged it against the SP section of `docs/v4/build-plan.md`, the task files SP.1 to SP.13, CLAUDE.md in the checkout, and "Rules that are easy to break" in `docs/HANDOVER.md`. Round 1 is `docs/reviews/SP-1.md`. It has no separate "Controller decisions" section. Its one standing decision, that agent dreams and team dreams count on the page and toward the caps, still holds. SP.6 to SP.10 came from the walkthrough. SP.11 to SP.13 are the follow-ups of the three round-1 must-fix findings. The diff also carries TM, SL, TX and other milestones merged since round 1. I read those only where they start runs or spend money.

## Verdict

Not clean. There is one must-fix finding. A cancelled cloud run still counts as $0 in the usual case, so round-1 must-fix 3 is only half resolved. SP.13 fixed the service side, but the cloud runtime never sends the result that would carry the cost. A scratch test proves it.

What I checked and found sound:

- SP.11. `startRun` and `startForGuest` both call `refuseIfWorkspaceOver`, the guest path through `guestReadiness`. It reads the workspace cap in the same query as the agent, in `findAgentWithWorkspaceCap`, so a workspace with no cap costs no extra query. The refusal is `agentPaused` with the workspace message, so every origin's existing handling applies. New, restored and resumed agents are all refused while the workspace is over its cap. `compose.ts` passes the full spend service to runs. The only exemptions are `continuationOf`, a person's answer to a parked run in `requests.ts`, then `wakesParent`, a child's end waking its parent, and `subagent`, a run that a running run spawns. None of them is a fresh start a member can make at will, and round 1 asked for exactly these. The five Check cases (a) to (e) each have a test in `spend-caps.test.ts`. The pause card drops Resume for a non-admin while the workspace limit holds the agent.
- SP.12. Managed runs now record usage on done, on failure, on `endFailed` and on the unreachable-Anthropic path, which reads usage before `abandon`. `list_cost.amount` is in minor units per the SDK type, so the divide by 100 is right. A run's usage is the session's totals minus the totals the previous run stored for the same Anthropic session. Token prices live in one place, `model-pricing.ts`, which the dream model now uses too. The managed cap test pauses an agent at $0.99 of $1 after a $0.02 run.
- SP.13 on the service side. `completeRun` accepts a late report with usage on a `cancelled` or `interrupted` run. It writes only `usage`, then runs `enforceCap`. `abortedCompletion` stores usage and enforces the cap. `ingestRunEvents` refuses a non-live run with `conflict`, which is what my scratch test's fake assumes.
- SP.6. An agent dream calls `enforceCap` when it ends, failed or not, and a failure there is swallowed.
- SP.7. `SpendRow` carries `micros`. `sumSpendCents` adds micros and rounds once. The page, the card and `capStatus` all use it, so the cap check and the page give the same figure.
- SP.8. The pause card shows the week next to the limit, drops Resume at or over the agent's limit, and the paused-mail notice adds "Send it again once the agent is resumed."
- SP.9. The minute tick, `liftCapPauses`, lifts a `spend_cap` pause only when both the agent and its workspace are under their caps, and leaves a `manual` pause alone.
- SP.10. `costThisWeekCents` is gone from the code, and the Home card reads the Spend page's rows.
- Every run still goes through the one insert in `runs.ts`. Team room runs start through inbox wakes, which already handle the paused refusal. The SP promise is "rollups from run usage", so model calls outside runs and dreams are out of scope here.
- Guards still hold: only an owner or an org admin on a browser session sets an agent cap or resumes, and only an org admin sets the workspace cap.

## Findings

| # | Severity | Finding | Area | Resolution |
|---|---|---|---|---|
| 1 | must-fix | A cancelled cloud run still loses its cost. `cancelOwnedRun` sets the run to `cancelled`, then the adapter tells the runner, and `core.cancel` aborts Pi. Pi commits the partial turn it was writing when aborted. The runner's last flush sends that turn to `ingestRunEvents`, which answers `conflict` because the run is no longer live. `step` then sets `gone`, and `work` skips `completeRun` whenever `gone` is set. So the late usage report that SP.13 taught the service to accept is never sent. A scratch test outside the repo used the test file's own fake with `abortLikePi`, the fake's model of what Pi commits on an abort. After a cancel, `completed` was empty. The control case, where Pi commits nothing after the abort, sent a completion with `costUsd: 0.5`. The SP.13 review flagged this as out of scope and no follow-up task exists. Cloud is the main runtime, so most cancelled runs still count as $0 on the page and toward both caps. | `apps/web/src/server/pi-run-core.ts` `step`, `work` | New task, scope below |
| 2 | nit | A cancelled managed run's cost is lost too. I read this from the code and did not run it. A cancel reaches `managed.interrupt`, which calls `abandon` and closes the Anthropic session without reading its usage. The next run gets a new Anthropic session, so `totalsBefore` starts from zero and the cancelled run's share never lands anywhere. The SP.12 review lists it. It was outside SP.13's scope, which named only the cloud runtime. It is the same class of gap as finding 1, so the controller may want to fold it into that task. | `packages/services/src/managed/service.ts` `interrupt` | Read usage before `abandon` and send it as a late report, or accept and record it |
| 3 | nit | An agent dream does not ask `workspaceOver` before it starts. It checks only `pausedAt`, while the team dream checks the workspace. A new or restored agent, or one a plain-member owner resumes, can run one paid dream while the workspace is over its cap. `enforceCap` then re-pauses it. The loop is bounded: a dream with nothing new since the last one is skipped at no cost, and nothing new builds up while runs are refused. So each agent gets at most about one extra Haiku dream. | `packages/services/src/dream/run.ts` `run` | Ask `workspaceOver` next to the `pausedAt` check, or accept |
| 4 | nit | An admin sees Resume on a pause card held by the workspace limit. Resume clears the pause and hides the card, but every start is still refused until the workspace limit goes up. | `components/spend/spend-pause-card.tsx` | Hide Resume whenever the workspace limit holds the agent |
| 5 | nit | SP.12 leftovers from its own review. The first run on a reused session after deploy is charged the session's whole lifetime use once. 1-hour cache writes are priced at the 5-minute factor. `sessionTotals` is stored inside the user-visible `runs.usage`. | `managed/usage.ts`, `model-pricing.ts` | Accept, or a small follow-up |

## Must-fix 1: a cancelled cloud run sends its cost

Scope: when the platform refuses a flush because the run has ended, which sets `gone` in `work`, the runner still sends one completion that carries the run's usage, so the late-report path that SP.13 added to `completeRun` records it and runs `enforceCap`. The usage comes from a fresh read of the slice after Pi's abort, not the `slice` variable. `slice` is not reassigned when `report` throws, so it lacks the aborted turn. A refusal of that completion still counts as "over", as now. Nothing else changes: no events, no reply text, no status change on the platform. A run whose final flush lands keeps today's path. If the controller folds in finding 2, `managed.interrupt` reads the session usage before `abandon` and sends it through the same late-report path.

Check: a `pi-run-core.test.ts` test with `abortLikePi`, where ingest answers `conflict` once the run is cancelled and status reads `cancelled`. After `core.cancel`, `completed` holds one result whose `usage.costUsd` covers the turns so far and the aborted turn. The two tests in the `cancel` describe that pin `completed` to `[]` change to expect that one usage-carrying completion. A real-services test (the "on the real services" harness in the same file) cancels a cloud run with a $1 agent cap and a $2 run, then shows the run stays `cancelled`, its `usage.costUsd` is 2, and the agent is paused with reason `spend_cap`. `bun run check && bun run test && bun run build` pass.

## Round 1 items

| Round 1 # | Item | Status |
|---|---|---|
| 1 (must-fix) | The workspace cap holds at the start of a run | Resolved by SP.11. All five Check cases have tests. New, restored and resumed agents are refused. Agent dreams are a bounded leftover, see nit 3. |
| 2 (must-fix) | Managed runs record their usage | Resolved by SP.12. Cancelled managed runs are still uncounted, see nit 2. |
| 3 (must-fix) | A cancelled run keeps its cost | Open. The service half landed in SP.13, and the cloud runtime still drops the report. See must-fix 1. Machine cancels stay uncounted by the task's own scope. |
| 4 (nit) | The agent Settings tab shows the editable limit to every member | Open. `CapField` still renders for any member. |
| 5 (nit) | The pause card falls back to the workspace cap for an agent with no cap | Open in the code (`agent?.weeklyCapCents ?? caps.workspaceCapCents`). SP.9's tick lifts the pause within a minute once the workspace is under its cap, so the window is now short. |
| 6 (nit) | `enforceCap` logs a failure and never retries | Open. For the workspace cap it no longer matters, because SP.11 checks the workspace at every start. It still matters for an agent's own cap. |
| 7 (nit) | Spend is dated by `runs.created_at` | Open. |
| 8 (nit) | A batched Slack message to a paused agent gets no reply | Open. `batch.ts` still keeps the messages unbatched with no notice. |
| 9 (nit) | "Set a limit" on `/spend` shows to every member | Open. |

## Test results on this commit

`bun install` passed. `bun run check` passed, boundary lint included. `bun run test` from the root passed in all 14 tasks with no failures: services 5,423, web 5,371, mcp 475, protocol 380, db 164, a2a 153, mailbox 139, library-sync 97, app-gateway 95, live-deck 64, live-doc 33, live-export 14, hooks 11, the Rust client 215 across its suites, and the scripts suite 426. Inside the services run, the spend and runs tests passed: `spend-caps.test.ts` 27, `spend-rollups.test.ts` 10, `spend.test.ts` 4, `runs.test.ts` 183 and `managed/managed.test.ts` 123. I did not run `bun run build`. The task logs record each merge check passing.

Scratch test: `cancel-usage.test.ts`, kept outside the repo, copied the helpers of `pi-run-core.test.ts` and added two cases. The cancel with an aborted turn failed with `completed: []`. The control case passed with one completion carrying `costUsd: 0.5`.

## Verdict

Not clean: one must-fix finding, number 1, and four nits, numbers 2 to 5. Round-1 must-fix 1 and 2 are resolved, must-fix 3 is open, and round-1 nits 4 to 9 are all still open.

## Controller decisions (2026-11-21)

- Must-fix 1 becomes SP.14. Nit 2 (a cancelled managed run loses its cost) is folded into SP.14, because it is the same gap on the other runtime.
- This is the second gate round, so SP closes when SP.14 is done. Nits 3 to 5 and round-1 nits 4 to 9 stay recorded here as open.
