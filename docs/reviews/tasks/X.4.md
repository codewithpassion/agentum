# X.4 review

## Rounds

Round 1, at 2a14cb3: must-fix, one item. The guardrail was only in the skill's text. Nothing named the "Ask me before" rules the investigator agent needs, and the skill told the model that some tools "have a rule" with nothing to make that true. The fix is the setup below (the rule list is the tool-permissions half of the guardrail) and a reworded `ask_user` sentence in the skill: ask with `ask_user` only when the tool has no rule, so a ruled tool is not asked about twice.

Round 2: pending.

## What was built

The skill `investigator-report` (`apps/web/skills/investigator-report/`) now has two scripts. `scripts/step.ts` posts one `investigation.step` (`{ incidentId, runId, text }`, source `agent`, `correlation_id` = incident id) to `$CONTROL_PLANE_URL/ingest/events` with the same envelope and no Authorization header as the result. `text` is cut to 500 UTF-16 units, the envelope summary to 200 code points, as control-plane's schema counts them. `scripts/report.ts` is unchanged and still carries the full `steps[]`. `SKILL.md` tells the agent to post a step before each check, retry or re-run, and holds the guardrail: read, retry jobs and re-run workflows on its own; config or credential changes, email and posts go to Dom first; denied, expired or cancelled approvals and a missing `ask_user` tool end in `escalate`.

The run link. control-plane builds it from the trigger URL's origin and the trigger response's `sessionId`: `<origin>/sessions?session=<sessionId>`. That is the page `apps/web/src/routes/_app/sessions.tsx`, which opens the transcript for the `session` search parameter. A trigger's session has origin `trigger` and is not private, so every member of the workspace can read it. Two tests in `packages/services/src/sessions.test.ts` pin this (a second member reads it, another workspace does not). A signed-out visitor is sent to `/login` and lands on `/` after signing in, not back on the link. The trigger response already carries `runId` and `sessionId`, and `triggers.test.ts` covers that.

## What depends on V1.10

The code in this task does not call V1. The guardrail relies on V1's rules, and the rules only gate a cloud agent's tool calls since V1.10. V1.10 was in `main` when this branch merged it, so the staging check below proves the approval half. If the check shows a ruled tool running without a request, V1.10 is not deployed to staging, and the skill's fallback (no `ask_user` tool, so escalate) is what stands between the investigator and the action.

## Differences from the task file

- The task says to post each step "as it goes" and put the full `steps[]` in the result. control-plane also turns each `steps[]` entry into its own `investigation.step` (`apps/engine/src/ingest/delivery.ts`, `deriveSteps`), so a step the agent posted live shows on the timeline a second time when the result arrives. The skill follows the task (full list in the result). Either control-plane drops derived steps whose text matches a posted one, or the coordinator tells us to report `steps` as the list of what is left out.
- The tool-permissions half of the guardrail is data on the agent (rows in `agent_tool_rules`), not code, because the investigator agent is created by hand (X.3). The rule list is under steps for Dom.

## Nits left

- The sessions tests pin behaviour that already existed. Nothing tests the `/sessions?session=` route component itself.
- A signed-out visitor to the run link is not returned to it after sign-in.
- Approval requests from a trigger-started run have no person to DM. Where the card shows for such a run (the agent's chat page, Slack) is part of the check below. Approvals expire after an hour by default, after which the call is denied and the skill says to escalate.
- Each step costs one `run_skill_script` call and one ingest request. A chatty run posts many. The skill asks for one per check, retry or re-run, with no hard cap.
- The step script has no timeout of its own, as the report script (the sandbox's 30 s wall time ends it).

## Beyond the scope

- Harbourmaster posting `investigation.step` itself when a trigger run opens an approval request or ends (from the same `runs.onEvent` listener as the fallback). The timeline would then show a waiting run even if the agent forgot to post. Today the skill asks the agent to post a step before a gated call.
- Rules as data in code: a service call or script that sets the investigator's "Ask me before" list, so a new investigator agent starts guarded.
- Returning a signed-out visitor to the run link after sign-in.

## Steps for Dom

The controller runs the staging check after merge and deploy. These steps extend X.3's (the staging hosts, the `CONTROL_PLANE_INGEST_TOKEN` proxy secret, the `CONTROL_PLANE_URL` env secret and the trigger from X.3 stay as they are). Nothing here has been done yet.

Changes to the X.3 setup:

1. Deploy Harbourmaster staging from the merged `main`.
2. Skills page: import the skill again, to get `step.ts` and the new `SKILL.md`. Build the archive with `cd apps/web/skills && zip -r /tmp/investigator-report.skill investigator-report`.
3. Agents page, agent `investigator`: replace the instructions with: "Investigate the incident named in the prompt. You may read, retry jobs and re-run workflows on your own. Anything that changes configuration or credentials, or sends email or posts anywhere, needs Dom's approval first through the approval flow, or you escalate instead. Follow the `investigator-report` skill: post each step as you go, and end every run, including one that failed or got stuck, by reporting."
4. Same agent, "Ask me before" list (settings tab): add these keys, type them in if they are not offered. Each key gets mode "ask".
   - Platform tools: `harbourmaster/send_message`, `harbourmaster/inbox_post`, `harbourmaster/slack_send`, `harbourmaster/bash`, `harbourmaster/create_routine`, `harbourmaster/set_routine_enabled`, `harbourmaster/delete_routine`, `harbourmaster/create_trigger`, `harbourmaster/set_trigger_enabled`, `harbourmaster/delete_trigger`, `harbourmaster/create_skill`, `harbourmaster/commit_skill`, `harbourmaster/revert_skill`, `harbourmaster/import_skill`, `harbourmaster/approve_skill_version`, `harbourmaster/reject_skill_version`, `harbourmaster/assign_skill`, `harbourmaster/unassign_skill`, `harbourmaster/pin_skill`.
   - Built-ins the agent has: `write`, `edit`, `bash`.
   - Every connector tool that sends, posts, or changes settings or credentials: the list suggests them as `<connector>/<tool>` (for example a mail connector's send tool). Leave the read and retry tools alone.
   - Never put a rule on `run_skill_script` or `ask_user`. The step and report scripts run through `run_skill_script`, and a rule there would stop the run from reporting.

The check (task X.4), on staging:

1. Steps. Fire the trigger as in X.3 with a new approval id, a fake incident id and this text:

   ```
   curl -sS -X POST "https://harbourmaster-staging.rockyshoreslabs.io/api/triggers/<trigger id>" \
     -H "Authorization: Bearer <hm_trg_ token>" -H "Content-Type: application/json" \
     -d '{"text":"Investigate incident inc_01HZX3Y5N7Q9R2T4V6W8A0B1C2 on test-system (severity action): this is a test run. Investigate nothing. Post two steps (\"checked the job\", \"nothing to retry\"), then report outcome escalate with the summary \"X.4 staging check\".","requestId":"apr_x4check1","waitMs":120000}'
   ```

   Pass when the response is `status: "done"` and `wrangler tail --env staging` in control-plane's `apps/engine` shows two `investigation.step` events and one `investigation.result`, all with `runId` equal to the response's `runId`. The router logs that it ignores them because the incident does not exist.
2. Link. Open `https://harbourmaster-staging.rockyshoreslabs.io/sessions?session=<sessionId>` (the response's `sessionId`) while signed in. Pass when the transcript shows the two step calls and the report. For the timeline half, use a real incident in the `approved` state through control-plane's own `start_hm_agent`: its timeline must carry the "investigation started" entry linking to that page, the steps and the outcome.
3. Approval instead of the action. Fire the trigger with a new approval id (`apr_x4check2`), `"waitMs":0` and this text: "Test run for incident inc_01HZX3Y5N7Q9R2T4V6W8A0B1C2. Call the platform tool slack_send to post 'X.4 test' to any destination you can list, then report." Pass when the run goes to `waiting` and an approval request for `harbourmaster/slack_send` appears (agent chat page, Needs you or the agent's Slack app) and nothing is posted to Slack. Deny it. The run must then report `escalate` and still post nothing. Note where the card showed up for a trigger-started run.
4. Same with `harbourmaster/create_trigger` (a change of configuration), approval id `apr_x4check3`. Same pass criteria. To see the allowed half, answer Allow once on one of the two and check the call ran.
5. If a ruled call runs without a request, V1.10 is not deployed on staging or the rule key does not match: compare the key in the approval card of a run that does ask (the card shows the tool key) with the list in step 4 of the setup.
