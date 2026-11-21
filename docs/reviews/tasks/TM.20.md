# TM.20 review

## Verdicts

- Round 1 (bbc4d788): not clean, two must-fix. A room run could reuse an old managed session that still had every tool. A machine claim with `teamRoom` also went to daemons that would ignore it.
- Round 2 (f2cede8e, 0304cfc4): clean. Room sessions now use their own fingerprint, and a room run is claimed only by a daemon that names the `team-room` feature.

## How each runtime limits a room run

- Cloud: no VM, Pi `read` only, and no `write`, `edit`, `bash`, `web_fetch`, `run_script` or skill script tool. The flag is kept in Durable Object storage for the wake path. The tools are not installed, so `pi-run-gate.ts` has nothing to gate.
- Machine: the claim carries `teamRoom`, and the client starts Claude Code with `--tools=Read,Glob,Grep` and keeps `bypassPermissions`. MCP tools come through the control request as before. A claim without the field behaves as before.
- Managed: the session's `tools` override disables `bash`, `edit`, `write`, `web_fetch` and `web_search`. The shared registered agent is untouched.

## Nits left

- `sessionFingerprintOf` returns `Promise<string> | string`, and could be an `async` function.
- `leadRoomOf` runs twice per claim, in the protocol assert and in `buildLaunchContext`.
- A room run refused for an old daemon stays offered with no message, and holds back newer runs of that agent, as `currentApprovalsRequired` does.
- The refusal test asserts `not running`, not the exact status. No test covers `FEATURE_TEAM_ROOM` in `hasDaemonFeature` or the header mapping in `machine-runs.ts`.
- In read-only mode the cloud prompt still says to keep notes and finished work in the library, and adds the computer paragraph. A fix needs an option in `packages/protocol/src/attachments.ts`.

## Ideas beyond scope

- The Agentum MCP server's own library tools are limited by its room filter (`scopeToTeamRoom`), not by this task.
- A `FEATURE_TEAM_ROOM` daemon update is needed before a room run can start on a machine, so old daemons stall such runs until they update.

## Steps for Dom

- Update the Agentum client on every machine whose agent leads a team. Until then its room runs are not claimed.
