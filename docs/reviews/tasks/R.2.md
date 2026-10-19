# R.2 review: run safeguards, turn limit, repeat guard and cancel

## Verdicts

- Round 1 (64e5e78): not clean. Three must-fix in the Pi stop and warning code, plus missing tests. The stop was worked out again from the final slice after the abort, and Pi's aborted partial turn and aborted tool results could hide it, so the run failed with a generic reason. The repeat warning came from an `afterTool` hook, which Pi does not run for calls it settles without executing (invalid arguments, unknown tool). The fake Pi had no abort behaviour that showed either.
- Round 2 (f057d66, fix commits only): not clean. One must-fix. After a failed abort, the next flush worked the stop out again from the slice, so a repeat stop vanished once the model changed its arguments and the abort was never retried.
- Round 3 (bfaed2e, fix commit only): clean.

## What was built

- `packages/protocol/src/safeguards.ts` holds the shared pure parts: the `maxTurns` key (10 to 500, default 100), the streak helpers, the stop messages and `runStopSchema`.
- `completeRun` takes an optional `stop` on a failed result. It stores the stop line as the error and records `run.limit_reached` or `run.repeat_stopped` before `run.failed`.
- Cloud (Pi) runs: `pi-run-core.ts` stops the model by aborting Pi when the run's slice shows the turn limit (limit reached and the model asked for tools) or 5 identical failed calls in a row. The stop is saved on the stored run before the abort and the abort is retried each flush until it goes through. The run then completes as failed with its usage. A run whose outcome is done is never turned into a stop. This covers the isolate and the Linux VM, which share the runner.
- The 3rd identical failed call gets a warning in its tool result. `pi-run-guard.ts` adds it in a `beforeRequest` hook on the generation task, as a function of the request messages. It keeps no state, so every later request carries it, and calls Pi settles without running count too.
- Machine runs: the daemon passes `maxTurns` to the Agent SDK. A result of subtype `error_max_turns` is reported as a failed completion with a `turn_limit` stop. `completeRequestSchema` accepts `stop` on failed completions only.
- Machine and managed runs get the repeat guard in `ingestRunEvents`. It reads the last 20 tool events of the run after a batch with a failed result, and ends the run as failed, tells the runtime to cancel, and offers the agent's next waiting run. Cloud runs are skipped there, because their runner keeps their usage.
- Managed runs have no turn limit. The events we read from an Anthropic session give no model turn count (an `agent.message` undercounts turns that only call tools), and `RUN_MAX_MS` still bounds a managed run to an hour. The agents service refuses `maxTurns` on a managed agent, so the setting never looks like it works.
- Agent config: `maxTurns` in `runtimeConfig` is validated for cloud and machine agents. The agent form has a Turn limit field for them (`agent-config.ts` builds the config for both the new-agent page and Settings).
- Cancel: `cancelRun` already ended the run as cancelled, recorded `run.cancelled` with the person as actor, called the runtime's cancel and offered the next waiting run for cloud. This task adds the refusal for run principals, the tRPC `runs.cancel`, a Cancel button in the chat (active run) and in the Log (on the `run.queued` and `run.started` rows of an active run, with `runStatus` added to `EventLogEntry`), and the `cancel_run` MCP tool. Read-only keys do not get `cancel_run`.
- The Log summary shows the stop reasons (the event's `error`) and "Cancelled by user <id>".

## Nits left

- `pi.abort` returns a boolean that the runner ignores, so "went through" means "did not throw".
- If every abort retry fails and the model then answers, the outcome is done and the saved stop is not used. The run is reported done.
- `stopRun` reads the stored run up to three times per flush.
- The warning in `pi-run-guard.ts` counts failures in the whole session conversation and in Pi's view order, while the stop counts per run in commit order. With parallel calls or a repeat that spans two runs they can disagree.
- Two different malformed calls (invalid JSON arguments) both look like `arguments: {}`, so they count as identical. `argumentsError` is not part of the key.
- The warning is added to the request only. It is not in the transcript or the Log.
- A repeat stop in a machine or managed run loses that run's usage. The stop count is the streak at the end of the batch, so a batch with ten failures reads "after 10".
- `stopOnRepeat` writes the run row, two events and the next offer as separate statements, not through `atomic`, like `cancelRun` today.
- `cancel_run` is offered to run principals (agents) that connect with a write token, and the service refuses them.
- The Log shows the raw user id in "Cancelled by user ...", not a name.
- Each active run shows Cancel on two Log rows (`run.queued` and `run.started`).
- The Pi extension is installed in the `PiRun` constructor, which no bun test reaches. The hook is covered by tests of `warnRepeats` and by reading the pi-durable sources.
- Agents already on machine or cloud that are switched to managed need `maxTurns` removed first. The form has no path for a runtime switch (the runtime is locked in Settings), so this does not come up in the UI.
- Machine cancel goes over the relay's WebSocket cancel frame (the daemon's `manager.cancel`), not at the daemon's next poll. The daemon also aborts on a refused heartbeat or event batch.
- A managed or machine run that is cancelled frees its agent for the next run through the minute sweep, not at once. Only cloud sets `offerNextOnEnd`.
- The live check `scripts/e2e/cloud.ts` could not run here. It fails the same way on `main` (the runner's `/mcp` call gets 503 in this environment), so the Pi hook and abort paths are covered by unit tests and the build only.

## Ideas beyond the scope

- Keep usage on a repeat stop for machine and managed runs, for example by having the runtime read a stop signal from the ingest answer and complete with it.
- A repeat warning for machine runs through a Claude Code hook.
- Count Managed Agents turns if Anthropic's session events expose the model requests.
- Show the 3rd-repeat warning in the transcript, by recording an event when it is added.
- Reset a cloud session's streak at the start of each run in the warning, to match the stop.

## Steps for Dom

- Deploy the Worker before the daemon: a daemon with this change sends `stop` on a turn-limit completion, and an older Worker rejects the key.
- On staging, run the controller's check: cancel a running Cloudflare run from the chat and see the next queued run start.
- To see the guard live, give a cloud agent a model that loops on a failing tool (the P.5 GLM-5.3 Flash case, a skill script called without `args`). The 3rd identical failure should carry the warning in the transcript the model sees, and the 5th should end the run as failed with "Stopped after 5 identical failed calls to run_skill_script in a row" and a `run.repeat_stopped` event in the Log.
- No migration is needed: the new event types are text values and `maxTurns` lives in `runtime_config`.
