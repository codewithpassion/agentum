# OB.1 review notes

## Verdicts

- Round 1, commit 034cf1e: must-fix. Start blank offered Cloudflare on an OpenRouter-only workspace, but `create` activated the agent on the Anthropic default model, so every run failed.
- Round 2, fix commit 5f843ea: the must-fix is resolved (a cloud agent without an Anthropic key gets `openrouter:z-ai/glm-5.3`). One new must-fix: a stale dry-run test. Fixed in the next commit. Fix round count: 2.

## What shipped

- `/agents/new` has a Describe it / Start blank switch. Start blank takes a name, what it does and a runtime, saves a draft and activates it through the existing `saveDraft` and `create`, with no builder call and no model key.
- `create` picks an OpenRouter model for a cloud agent when the workspace has no Anthropic key. It reads that from the catalog: `managed` is on offer only with an Anthropic key.
- The dry run panel says where it runs. It always runs on Cloudflare with the default Anthropic model. It tells a machine or Anthropic cloud agent that its own runtime is not the one tried, and blocks the run (not Create) when there is no Anthropic key.

## Nits left

- The dry run does not use the chosen runtime for machine or Anthropic cloud agents. The dry-run path is hardcoded to the cloud adapter in `runs.ts`, and a draft row is always `cloud` until activation. It says so instead. Running a dry run on a machine is a larger task.
- The dry-run "no key" branch is unreachable from the page today, because a builder draft needs an Anthropic key. It is correct if the dry run is ever offered elsewhere.
- Create after a partial failure reuses the draft id. If `create` activated the agent and a later step (address) failed, a retry fails on "not a draft".
- The builder's no-key error links to Settings only, not to Start blank.
- `create` fetches the catalog twice.

## Ideas beyond scope

- Open the page on Start blank when the workspace has no Anthropic key.
- Let a draft keep its own model so an OpenRouter-only workspace can dry run.

## Not verified

- Staging check (machine agent with no Anthropic key): the controller runs it after the merge.
- Browser check on local dev passed with an OpenRouter key only: Start blank on Cloudflare created the agent and opened its page. A machine agent was not tried locally.
- `guest-execution.test.ts` (workerd) timed out on this branch and on main under load. It is not touched by this task.
- `agentum-rs` test `abort_escalates_to_kill_and_reaps_whole_group` failed once under load and passed on rerun.

## Steps for Dom

None.
