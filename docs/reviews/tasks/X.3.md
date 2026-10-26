# X.3 review

## Rounds

Round 1, at 45bf70a: must-fix, three items. The fallback read the incident id from the trigger request id, but control-plane's `start_hm_agent` sends its approval id (`apr_...`) there, so it could never fire. The fallback post had no timeout, and on paths composed without `defer` (the PiRun object, the tick) it runs inline before the run's end write finishes. Payload strings were cut by code points while control-plane's zod limits count UTF-16 units, so an emoji-heavy summary would get a 400.

Round 2, at d33373c (fix commit only): clean. The fallback now reads the incident id from the run's prompt (only for runs whose request id starts with `trigger:`), posts with a 5 s timeout, cuts by UTF-16 units without half a surrogate pair, drops format characters and lone surrogates from the envelope summary, and passes the error text through `redactText`.

## What was built

The skill `investigator-report` (`apps/web/skills/investigator-report/`) is the happy path. The agent runs `scripts/report.ts` once through `run_skill_script` with a JSON argument. The script posts one `investigation.result` to `$CONTROL_PLANE_URL/ingest/events` and sends no Authorization header, because the platform's outbound proxy adds it from the proxy secret `CONTROL_PLANE_INGEST_TOKEN`. The script never holds the token. It reads the run id from `HM_RUN_ID`, which `pi-run.ts` now adds to every skill script's environment (the `HM_` prefix is reserved, so no workspace secret can clash).

`@repo/services/investigator-report` is the fallback for what the agent cannot do itself. It is a `runs.onEvent` listener (wired in `compose.ts`). When a run that a trigger started ends `run.failed` (which includes "Never claimed"), `run.cancelled` or `run.interrupted`, its prompt holds an incident id, and its agent holds the proxy secret `CONTROL_PLANE_INGEST_TOKEN`, Harbourmaster posts the `escalate` result itself, to the host of that secret's rule. A run that ends `done` without reporting (the agent forgot, or the post failed) is not covered. Its result text says so, and control-plane escalates after its own timeout, as the task asks.

The envelope follows C3, not the task file: `source: "agent"`, actor `harbourmaster-investigator`, `correlation_id` = incident id, severity `info`, plus `fingerprint`, `system_id: null` and `ts`, which control-plane's input schema requires. It was checked against `packages/events/src/envelope.ts` and `investigation.ts` on control-plane's branch `feat/investigator-visibility`.

## Differences from the task file

- The task file says `source: "harbourmaster"`. control-plane has no such source (contract C3 explains), so the code sends `agent`.
- The task file says the incident id arrives "as `requestId`". control-plane's `start_hm_agent` sends the approval id as `requestId` and the incident id only in the text (the default `text_template` starts "Investigate incident {incident_id}"). The skill takes the id from the prompt. The staging check below therefore uses a fake approval id as `requestId` and the fake incident id in the text. The coordinator may want to correct the task text and C1.
- control-plane accepts `investigation.result` only after `feat/investigator-visibility` is deployed there. On `main` the type is not in its event list, so ingest would answer 400.

## Nits left

- A routine also starts runs with a `trigger:` request id. A routine run of an agent that holds the ingest token and whose prompt mentions an `inc_` id would post an escalation. No such routine is planned.
- The fallback takes the first incident id in the prompt. A custom `text_template` that puts `{incident_summary}` before `{incident_id}` could pick a different incident if the summary names one. The default template is safe.
- The skill script's `fetch` has no timeout of its own. The sandbox's 30 s wall time ends it.
- In the skill's event summary, a format character between two spaces leaves a double space (cosmetic).
- The fallback cannot tell that the agent already reported. A run that reports `fixed` and then fails posts a second, misleading `escalate`. control-plane ignores it, because it acts on a result only while the incident is `approved`.
- The fallback host comes from the proxy rule and the skill's host from the `CONTROL_PLANE_URL` secret. If they differ, the two paths report to different places. Set both to the same host.
- The sandbox test sets `process.env` itself, because the local loader does not fill it from the run's `env`. That workerd does is shown by S.3's staging probe, not by this test.
- The "gives the post a timeout signal" test checks for a signal, not for 5000 ms.

## Beyond the scope

- `investigation.step` progress events while the agent works (the C3 addition). The result's `steps` already show on the timeline.
- One source for the control-plane host, for example the skill reading the proxy rule host, so the two paths cannot differ.
- A generic "on run end, call a webhook" setting on a trigger, which would replace the fallback's special case.

## Steps for Dom

The controller runs the staging check after merge and deploy. Everything below is on staging, in the Harbour Edge Intelligence workspace. Nothing here has been created yet. The staging hosts are https://harbourmaster-staging.rockyshoreslabs.io and https://controlplane-engine-staging.rockyshoreslabs.io.

Before the check:

1. Deploy Harbourmaster staging from the merged `main`. The `HM_RUN_ID` variable and the fallback come with it. Confirm control-plane staging runs `feat/investigator-visibility` (it must accept `investigation.result`).
2. Make a control-plane staging token with scope `ingest:events` and client id `hei`, as `apps/engine/README.md` describes for `create-token.ts` (`--name hm-investigator --scopes "ingest:events" --env staging --client-ids "hei"`). The `cpt_` token is shown once.
3. Secrets page, two workspace secrets:
   - `CONTROL_PLANE_INGEST_TOKEN`, mode `proxy`, value the `cpt_` token, one rule: host `controlplane-engine-staging.rockyshoreslabs.io`, header `Authorization`, template `Bearer {value}`.
   - `CONTROL_PLANE_URL`, mode `env`, value `https://controlplane-engine-staging.rockyshoreslabs.io`.
4. Skills page, import the skill. Build the archive with `cd apps/web/skills && zip -r /tmp/investigator-report.skill investigator-report`, then import `/tmp/investigator-report.skill` (or use the `import_skill` tool). A person's import is approved at once.
5. Agents page, create the agent `investigator` with runtime `cloud` (`run_skill_script` exists only there) and the workspace's usual cloud model. Instructions: investigate the incident named in the prompt using read access and retries only, never change configuration or credentials and never send email or post anywhere without asking Dom through the approval flow (or escalate instead), and end every run, including one that failed or got stuck, by running the `investigator-report` skill once. Assign the skill `investigator-report` to it and grant it both secrets.
6. Triggers page, create an HTTP trigger for `investigator`. Copy its URL and `hm_trg_` token (shown once).
7. To wire control-plane itself (not needed for the check): `wrangler secret put HM_TRIGGER_TOKEN_INVESTIGATOR --env staging` with that token, and the `allowed_actions` row in control-plane's HANDOVER section "Investigator visibility", with `trigger_url` set to the trigger's URL.

The check (task X.3):

1. Fire the trigger with a fake incident id (26 characters of Crockford base32 after `inc_`) and a fake approval id as `requestId`:

   ```
   curl -sS -X POST "https://harbourmaster-staging.rockyshoreslabs.io/api/triggers/<trigger id>" \
     -H "Authorization: Bearer <hm_trg_ token>" -H "Content-Type: application/json" \
     -d '{"text":"Investigate incident inc_01HZX3Y5N7Q9R2T4V6W8A0B1C2 on test-system (severity action): this is a test run. Investigate nothing. Report outcome escalate with the summary \"X.3 staging check\" and one step.","requestId":"apr_x3check1","waitMs":120000}'
   ```

2. Pass when the response has `status: "done"` and the run's transcript (the `/sessions?session=<sessionId>` page) shows `run_skill_script` printing `reported escalate for inc_01HZX3Y5N7Q9R2T4V6W8A0B1C2: HTTP 202`. In control-plane staging (`wrangler tail` in `apps/engine` with `--env staging`) one `investigation.result` arrives with `source` `agent` and `runId` equal to the response's `runId`. The router logs "router ignored an investigation.result", because the incident does not exist. For a full loop use a real incident that is in the `approved` state: `fixed` then resolves it and `escalate` moves it to the human lane.
3. Fallback check: fire the trigger again with a new `requestId` (`apr_x3check2`) and `"waitMs":0`, then cancel the run at once (Sessions page, or the `cancel_run` tool). Harbourmaster itself posts a second `investigation.result` with `outcome: "escalate"`, and the engine's tail shows it. If the agent had already reported, you see two results. That is expected in this case.
4. If the script prints `report failed: ...`, the agent's answer begins by saying so. Check that `CONTROL_PLANE_URL` is set and granted, that the token's scope is `ingest:events` with client id `hei`, and that staging runs `feat/investigator-visibility`.
