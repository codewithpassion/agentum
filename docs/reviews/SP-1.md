# SP milestone gate, round 1

This review covers commit 2b9dcc90 on main, diff `sp-start..2b9dcc90`. I judged it against the SP section of `docs/v4/build-plan.md`, the task files SP.1 to SP.5, CLAUDE.md in the checkout, and "Rules that are easy to break" in `docs/HANDOVER.md`. SP.6 to SP.10 are known and not repeated here: an agent dream that crosses a cap, per-day rounding, the Resume card wording, the Monday lift and the Home card figure. The controller decisions hold in the code. Agent dreams and team dreams count on the page and toward the caps.

## Verdict

Not clean. There are three must-fix findings. A plain member can keep starting work past the admin's workspace cap. Two kinds of spend never reach the rollups: managed-runtime runs and cancelled runs.

What I checked and found sound:

- Every run goes through the one insert in `runs.ts`, and `refuseIfPaused` guards both `startRun` and `startForGuest`.
- Queued runs wait at all three claims (cloud, machine, managed).
- Reserved request ids are refused whatever their case.
- I read the paused-refusal handling for routines, inbox wakes, Slack mentions (a reply in the thread), the Slack batch (silent, see nit 8), A2A (task failed, with the paused status text), the web trigger (the error goes back to the caller) and the dream (agent dreams skip a paused agent, and a team dream asks `workspaceOver`).
- Only an owner or an org admin on a browser session can set an agent cap. Only an org admin can set the workspace cap.
- `agents.setOwners` is owner or admin only, so a member cannot make themselves owner and then resume.
- No MCP tool or agent update path writes `weekly_cap_cents` or `paused_at`.
- Migration 0056 and its `meta/` snapshot are committed, and `spend_pause` is in `NEEDS_YOU_KINDS`.
- The spend service tests pass (28 of 28). The root `bun run check` and `bun run test` results are in the last section.

## Findings

| # | Severity | Finding | Area | Resolution |
|---|---|---|---|---|
| 1 | must-fix | The workspace cap does not hold at the service. The start gate reads `paused_at` alone and never asks whether the workspace is over its cap. So a plain member who owns an agent can click Resume and start a run, as often as they like, while the workspace stays over the admin's limit. The run that ends re-pauses the agent, but each Resume buys one more run of any cost. A scratch test outside the repo set a $1 workspace cap and spent $1.50. A plain-member owner then resumed twice and spent $5 each time, ending the week at $11.50. `setCap` on the workspace still refused that member. A new agent made while the workspace is over its cap starts runs too, because `pauseActive` only pauses agents that are active at that moment. So does an archived agent restored then, since `agents.restore` only sets `status` back to active. SP.8 and the walkthrough's notes cover the card. This finding is about the service. A non-admin can repeat it without limit, and new or restored agents slip past the workspace pause entirely. | `runs.ts` `refuseIfPaused`, `spend.ts` | New task, scope below |
| 2 | must-fix | Managed-runtime runs record no usage. `managed/service.ts` completes runs with `{ status, text }` or `{ status, error }` and never passes `usage`, and nothing else under `managed/` writes it. Every managed run adds $0 to the page and to both caps. A cap on a managed agent never pauses it, and managed spend never counts toward the workspace cap. The gap predates SP, but SP's caps promise to cover every agent. | `packages/services/src/managed/service.ts` | New task, scope below |
| 3 | must-fix | A cancelled run's spend is dropped. `cancelRun` moves the run to `cancelled` with no usage. The cloud runtime then aborts Pi and sends `completeRun` a result that carries usage (`work` and `completeRun` in `pi-run-core.ts`), but `completeRun` refuses any run that is not live, and the cloud side treats the refusal as "over". A scratch test confirmed the service half: a usage report after a cancel gets a conflict, `usage` stays null and no pause follows. `enforceCap` never runs on cancel. The machine client completes a cancel as `{"status":"aborted"}` with no usage, and `abortedCompletion` would drop usage anyway. A long run that a person cancels near the end counts as $0. The gap predates SP. | `runs.ts` `cancelRun`, `completeRun`, `abortedCompletion`; `apps/web/src/server/pi-run-core.ts` | New task, scope below |
| 4 | nit | The agent Settings tab shows the editable weekly limit to every member. A member who is neither the owner nor an admin can type a limit and press Save, then gets "Not allowed: spend.write". The workspace page already shows read-only text to non-admins, and the tab already computes `canManageAgentKeys`. | `components/agent/room/settings/index.tsx` | Show the limit read-only unless the viewer is the owner or an admin |
| 5 | nit | On the pause card, an agent with no cap of its own falls back to the workspace cap for its limit line (`agent?.weeklyCapCents ?? caps.workspaceCapCents`). Once the workspace is under its cap again, the card reads "The limit is $X a week", and "Raise the limit" prefills the workspace figure and saves it as the agent's own cap. | `components/spend/spend-pause-card.tsx` | Say the workspace limit held it, and don't prefill an agent cap from the workspace cap |
| 6 | nit | `enforceCap` in `runs.ts` catches and logs every error. A failed check is never retried, so that crossing goes unenforced until some later run ends. | `runs.ts` `enforceCap` | Accept, or retry once and record a failure event |
| 7 | nit | Spend is dated by `runs.created_at`. A run created on Sunday night that finishes after Monday 00:00 counts in the week before, so this week's cap never sees it. The same goes for a run that a pause held across a week boundary. | `spend.ts` `read` | Accept and say so in the page help, or date by `finished_at` when set |
| 8 | nit | A message in a batched Slack channel to a paused agent stays unbatched with no reply, so the sender never learns why nothing happened. SP.3 asks for a reply to Slack senders. Mentions get one, but the batch path does not. | `packages/services/src/slack/batch.ts` | Post the paused notice once per batch window, or accept and note it |
| 9 | nit | The "Set a limit" button on `/spend` shows to every member, and a non-admin lands on a read-only page. | `routes/_app/spend.tsx` | Hide it for non-admins, or label it "Limits" |

## Must-fix 1: the workspace cap holds at the start of a run

Scope: `startRun` and `startForGuest` refuse a new start while the agent's workspace is at or over its weekly cap. The check uses the same week-to-date as `spend.workspaceOver`, team dreams included. It applies to every agent in the workspace, paused or not, so new and restored agents are covered. The follow-ups of work under way stay exempt, the same ones `refuseIfPaused` exempts: `continuationOf`, `wakesParent` and `subagent`. The refusal is the existing `agentPaused` conflict, with a message that names the workspace limit, so every origin's existing handling still applies. With no workspace cap the check costs no query. `spend.resume` is unchanged: it clears the pause, and the start gate decides whether work can begin. The pause card for an agent held by the workspace limit tells a non-admin that only raising the workspace limit lets it run, and drops Resume for them.

Check: service tests in `spend-caps.test.ts`.

- (a) Workspace cap $1, then a run that costs $1.50. After a plain-member owner's `spend.resume`, `startRun` on that agent is refused with reason `agent_paused`.
- (b) A member creates a new agent while the workspace is over its cap. Its first `startRun` is refused.
- (c) An answer to a parked run (`continuationOf`) and a subagent still start while the workspace is over its cap.
- (d) With no workspace cap, or a cap still above the week, no start is refused.
- (e) After an admin raises the workspace cap above the week, a resumed agent starts.

A component test shows the pause card without Resume for a non-admin while the workspace limit holds the agent. `bun run check && bun run test && bun run build` pass.

## Must-fix 2: managed runs record their usage

Scope: every managed completion passes `usage`, with input and output tokens and `costUsd`, read from what the managed session reports. That covers a run that ends done, one that fails, and the `failRun` and `endFailed` paths. If the API reports tokens and no cost, price them from the model's rates in one shared place that the other runtimes can reuse, never in a second price table. `enforceCap` then runs through the normal `completeRun` path. If the managed API reports no usage at all, record that in the task log. The agent's Settings cap field then says that spend is not tracked for this runtime, so an owner is not misled by a cap that can never fire.

Check: a managed service test where the fake session reports usage, and the finished run's `usage.costUsd` is set. A cap test where a managed agent at $0.99 of a $1 cap finishes a run that costs $0.02 and ends paused with reason `spend_cap`. `bun run check && bun run test && bun run build` pass.

## Must-fix 3: a cancelled run keeps its cost

Scope: a run that ends `cancelled` or `interrupted` keeps the usage its runtime reports afterwards. `completeRun` accepts a late report on such a run and writes only `usage`, with no change to status, reply or events. `enforceCap` then runs. The cloud runtime still sends its result after an abort, as it does today, and that result now lands. `abortedCompletion` stores `usage` when a completion carries it. The machine client is out of scope: it sends no usage on abort, and machine cancels stay uncounted. Record that in the task log.

Check: a runs service test where a run is cancelled and then gets `completeRun` with `{ status: "failed", usage: { costUsd: 2 } }`. The run stays `cancelled`, its `usage.costUsd` is 2, and with a $1 cap the agent is paused. An `aborted` completion that carries usage stores it. `bun run check && bun run test && bun run build` pass.

## Root check and test on this commit

`bun run check` passed, boundary lint included. `bun run test` from the root passed in every package with no failures: services 5,255, web 5,270, mcp 471, the Rust client and the rest. I did not run `bun run build`. The task logs record it passing on main after each merge.

## Verdict

Not clean: three must-fix findings (1, 2 and 3) and six nits.
