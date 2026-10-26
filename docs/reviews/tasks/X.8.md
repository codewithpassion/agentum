# X.8 review

## Rounds

Round 1, at 3aa390e: clean after 0 fix rounds. The reviewer checked event order on Pi cloud, managed and daemon runs (the run's `tool.result` events are stored before `run.finished`), the output wrapper and masking, the incident id pattern, and the layering. Check, tests and build passed in its worktree.

## What was built

A trigger run of an incident that ends `run.finished` now posts the same `escalate` `investigation.result` as a failed run, unless it already reported. "Reported" means a `tool.result` event of the run with `ok: true` holds a line `reported <fixed|escalate> for <incident>: ` at the start of a line. That is what `scripts/report.ts` prints after control-plane accepted the post. `createReportedReader(db)` reads it and is the new `reported` dep of `createInvestigatorReportBack`, wired in `compose.ts`. A done run gets the text "The investigator run finished before it reported."; failed, cancelled and interrupted runs are unchanged and do not check for a report. The services README is updated.

## Nits left

- A failed last event batch on the daemon (`apps/daemon/src/executor.ts` `batcher.flush()` never rejects) can hide the report line, so a run that did report gets a second result. Control-plane ignores it once the incident is no longer `approved`.
- Any `tool.result` with `ok: true` counts, so a tool that echoes a line starting `reported fixed for <incident>: ` could suppress the fallback. Pairing it with its `tool.call` (`run_skill_script`, `scripts/report.ts`) through `toolUseId` would close that.
- One malformed stored payload makes `JSON.parse` throw, and then no escalate goes out. The error is logged.
- The reader loads and parses every `tool.result` payload of the run. A SQL `LIKE` prefilter would cut that.
- The reader ignores `payloadRef`. The report line is short, so it never overflows.
- No test uses the real `exit code: 0 ... stdout:` wrapper.
- The success line of `report.ts` is now a contract with services. Nothing in the script says so.
- The fallback takes the first incident id in the prompt, as in X.3.

## Ideas beyond the scope

- Have the skill's `report.ts` write a marker the platform can read (an event type), instead of matching the printed line.

## Steps for Dom

None beyond the X.3 staging setup. After deploy, the staging check is: fire the investigator trigger with a prompt that makes the agent end without calling `report.ts` (or deny the approval, as in run 01M5VJJKTQBEXJQ6G6B0D113D4), and confirm control-plane receives one `investigation.result` with `outcome: "escalate"` and the run's `runId`. Then fire one where the agent reports, and confirm only one result arrives.
