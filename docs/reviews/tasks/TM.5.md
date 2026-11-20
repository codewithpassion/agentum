# TM.5 review

## Verdict

Round 1, commit fec916eb: must-fix. One item. `contextBudget` reaches the machine claim but has no effect on a machine run, and nothing recorded that.
Round 2, commit 71d148de: clean. The gap is written down in comments in `apps/agentum/src/claude.rs` and `packages/services/src/managed/service.ts`. The task's scope asks the client only for the effort flag, and Claude Code's `--autocompact` is not verified for the client's minimum version (2.1.300).

## What changed

`@repo/db/shared` holds the one table, `CONTEXT_BUDGET_COMPACTION_TOKENS` (small 100k, standard 200k, large 500k tokens of context before compaction), and three small readers: `effortOf`, `contextBudgetOf` and `runtimeConfigForRun`. The readers return nothing for a missing or unknown value, so an agent with no setting behaves as before. The token values are a first guess, tune them in that one table.

Cloud (Pi): `pi-run-core.ts` calls `setEffort` and `setContextBudget` next to `setModel` and `setInstructions`, at a start and when a wake submits a run again, and keeps both on the stored run. `pi-run.ts` sets the session's `thinkingLevel` (null clears it back to Pi's default, "off") and a compaction policy that `pi-run-tuning.ts` computes from the model's context window (`reserveTokens = window - threshold`, never below Pi's default reserve). Pi reads `settings.compaction` on every use, so a getter carries the value without reopening the harness. The policy is also stored, so a wake keeps it.

Managed Agents: `gateway.ts` sends `model: { id, effort }` when the agent has a level and the plain string when it has none. `syncAgent` always sends the object with `effort: null` when unset, so removing a setting clears the stored one at Anthropic. The level joins the agent fingerprint only when set, so an agent without one keeps its fingerprint and its sessions. Managed Agents has no context-size setting, so `contextBudget` is not used there.

Machine: `machine-claim.ts` already sent the whole `runtimeConfig`. The client (`claude.rs`, `helpers::effort`) passes `--effort low|medium|high` and ignores any other value.

Subagents keep their own settings (docs/v3/subagents.md): `runtimeConfigForRun` drops `effort` and `contextBudget` from the config of a run whose `subagentLevel` is above 0, in the cloud runtime, the machine claim and the managed launch. This is my reading of "subagents keep their own setting", since the doc gives a subagent a model and nothing else. If the intent was that a helper inherits its parent's level, delete the `runtimeConfigForRun` calls.

## Nits left

- `apps/agentum/src/claude.rs`: `contextBudget` is not passed to Claude Code on machine runs. Nothing outside the code comments tracks it.
- `apps/agentum/src/runs/helpers.rs`: the Rust `effort` copies the level list by hand. The parity test (`parity.ts`) does not cover it, so the two lists can drift.
- `apps/agentum/src/runs/review_tests.rs`: `unknown_effort_passes_no_effort_flag` repeats the argv and env set-up of the test above it.
- `packages/services/src/managed/gateway.ts`: a subagent session sends the bare model string as its override. If Anthropic keeps the registered agent's stored effort for that, a helper would run at its parent's level. Unverified.
- `packages/services/src/managed/service.ts`: the note on `contextBudget` sits in the doc comment of `effortOfRun`.
- `apps/web/src/server/pi-run.ts`: one compaction policy per session object. A run that joins a busy session keeps the earlier run's budget, like `setModel` does.

## Beyond the scope

- Machine runs and the context budget: pass `--autocompact <tokens>` (in the shipped 2.1.327 help: "auto, or at least 100k tokens") from the table. First check the flag against 2.1.300, or raise the minimum version. The table has the token counts, and the Rust side would need a copy or the claim could carry the number.
- The effort list in the UI is low, medium, high. Claude Code and Managed Agents also take `xhigh` and `max`, and Pi's model map has them. Adding them means widening `EFFORT_LEVELS` in `@repo/db/shared` and the Rust `effort`.

## Test notes

- Tests per runtime that the values reach the call: `pi-run-core.test.ts` (Pi port), `cloud/runtime.test.ts` (runner start input), `managed/gateway.test.ts` and `managed/managed.test.ts` (gateway calls and fingerprint), `runs/machine-claim.test.ts` (claim), `review_tests.rs` and `tests.rs` (argv). An unknown stored value never reaches the managed service in a test, because the agent read path rejects it first; the readers' tests in `packages/db/src/effort-and-context.test.ts` cover the guard.
- `wrangler types` has to have run in `apps/web` (copy `.env.example` to `.env` first) or the web typecheck reports a pile of `Env` errors. The reviewer's `cargo` run failed on this host until `~/.local/bin/cc` was taken off PATH.

## Steps for Dom

- Decide the three token values in `CONTEXT_BUDGET_COMPACTION_TOKENS` and whether a helper should inherit its parent's level. Neither needs an account or a dashboard.
- Nothing to deploy or migrate: the settings live in the existing `runtimeConfig` JSON.
