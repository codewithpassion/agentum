# X.4 review

## Rounds

Round 1, at 2a14cb3: must-fix, one item. The guardrail was only in the skill's text. Nothing named the "Ask me before" rules the investigator agent needs, and the skill told the model that some tools "have a rule" with nothing to make that true. The fix is the setup below (the rule list is the tool-permissions half of the guardrail) and a reworded `ask_user` sentence in the skill: ask with `ask_user` only when the tool has no rule, so a ruled tool is not asked about twice.

Round 2, at 675a47b (fix commit only): must-fix, two items. The skill told the model to ask with `ask_user` only for tools without a rule, which it cannot know. The rule list left out `web_fetch`, which can send POST requests and so can post or send mail through any HTTP API. The fix: the skill says to ask unless it knows the tool has a rule (a double ask is the cheaper failure), and `web_fetch` joins the list. The reviewer also confirmed that all 19 platform keys are real, match `toolKey` and the cloud gate, and that no rule belongs on `run_skill_script`.

Round 3, at f749cab (fix commit only): must-fix, three items. The note that `run_script` holds no secrets was wrong, because it fetches through the same fetcher as `web_fetch`. `run_script` was missing from the rule list. Check steps 3 and 4 failed if the tester denied the `ask_user` question the skill now asks first. The fix: `run_script` is ruled like `web_fetch` with the trade-off recorded, the steps approve the `ask_user` question and then deny the tool request, the skill says to read through connectors, and the connector-key note is explicit.

Round 4, at 874ad06 (fix commit only, after merging main): clean. Nits it left: the skill's remark that `web_fetch` and `run_script` calls wait for Dom is true only once setup step 4 has added those rules (the setup is a required step).

## What was built

The skill `investigator-report` (`apps/web/skills/investigator-report/`) now has two scripts. `scripts/step.ts` posts one `investigation.step` (`{ incidentId, runId, text }`, source `agent`, `correlation_id` = incident id) to `$CONTROL_PLANE_URL/ingest/events` with the same envelope and no Authorization header as the result. `text` is cut to 500 UTF-16 units, the envelope summary to 200 code points, as control-plane's schema counts them. `scripts/report.ts` is unchanged and still carries the full `steps[]`. `SKILL.md` tells the agent to post a step before each check, retry or re-run, and holds the guardrail: read, retry jobs and re-run workflows on its own; config or credential changes, email and posts go to Dom first; denied, expired or cancelled approvals and a missing `ask_user` tool end in `escalate`.

The run link. control-plane builds it from the trigger URL's origin and the trigger response's `sessionId`: `<origin>/sessions?session=<sessionId>`. That is the page `apps/web/src/routes/_app/sessions.tsx`, which opens the transcript for the `session` search parameter. A trigger's session has origin `trigger` and is not private, so every member of the workspace can read it. Two tests in `packages/services/src/sessions.test.ts` pin this (a second member reads it, another workspace does not). A signed-out visitor is sent to `/login` and lands on `/` after signing in, not back on the link. The trigger response already carries `runId` and `sessionId`, and `triggers.test.ts` covers that.

## What depends on V1.10

The code in this task does not call V1. The guardrail relies on V1's rules, and the rules only gate a cloud agent's tool calls since V1.10. V1.10 was in `main` when this branch merged it, so the staging check below proves the approval half. If the check shows a ruled tool running without a request, V1.10 is not deployed to staging, and the skill's fallback (no `ask_user` tool, so escalate) is what stands between the investigator and the action.

## Differences from the task file

- The task says to post each step "as it goes" and put the full `steps[]` in the result. control-plane also turns each `steps[]` entry into its own `investigation.step` (`apps/engine/src/ingest/delivery.ts`, `deriveSteps`), so a step the agent posted live shows on the timeline a second time when the result arrives. The skill follows the task (full list in the result). Either control-plane drops derived steps whose text matches a posted one, or the coordinator tells us to report `steps` as the list of what is left out.
- The task's check says "send mail or change a secret". The staging check below uses `slack_send` (a post) and `create_trigger` (a config change). No platform tool changes a secret, and mail goes through a connector, which this workspace may not have for the investigator. If it has one, swap in its send tool for step 3, and put that tool's key (`<connector>/<tool>`) in the "Ask me before" list first.
- The tool-permissions half of the guardrail is data on the agent (rows in `agent_tool_rules`), not code, because the investigator agent is created by hand (X.3). The rule list is under steps for Dom.

## Nits left

- The sessions tests pin behaviour that already existed. Nothing tests the `/sessions?session=` route component itself.
- A signed-out visitor to the run link is not returned to it after sign-in.
- Approval requests from a trigger-started run have no person to DM. Where the card shows for such a run (the agent's chat page, Slack) is part of the check below. Approvals expire after an hour by default, after which the call is denied and the skill says to escalate.
- Each step costs one `run_skill_script` call and one ingest request. A chatty run posts many. The skill asks for one per check, retry or re-run, with no hard cap.
- The step script has no timeout of its own, as the report script (the sandbox's 30 s wall time ends it).

- The skill's text that `web_fetch` and `run_script` calls wait for Dom holds only after setup step 4 adds those rules. A decision, not a defect: `run_script` is ruled like `web_fetch` (same fetcher and secret placeholders, network on by default), so the investigator's ad hoc scripts each ask, and `run_skill_script` is untouched.

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
   - Built-ins: `write`, `edit`, `web_fetch` and `run_script`. `web_fetch` and `run_script` can send requests with secret placeholders filled in, so they can post or mail through any HTTP API, and their plain reads will ask too. The investigator reads through its connectors instead, and the skill says so. `bash` as well, if the agent runs in the Linux VM environment.
   - Every connector tool that sends, posts, or changes settings or credentials: the list suggests them as `<connector>/<tool>` (for example a mail connector's send tool). The connector's key goes in this list too, not only the platform's. Leave the read and retry tools alone.
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
3. Approval instead of the action. Fire the trigger with a new approval id (`apr_x4check2`), `"waitMs":0` and this text: "Test run for incident inc_01HZX3Y5N7Q9R2T4V6W8A0B1C2. Call the platform tool slack_send to post 'X.4 test' to any destination you can list, then report." The skill makes the agent call `ask_user` first, so the first request may be a question. Answer it so the agent goes ahead (approve). Pass when the run then goes to `waiting` again and an approval request for `harbourmaster/slack_send` appears (agent chat page, Needs you or the agent's Slack app) and nothing is posted to Slack. Deny that request. The run must then report `escalate` and still post nothing. Note where the card showed up for a trigger-started run.
4. Same with `harbourmaster/create_trigger` (a change of configuration), approval id `apr_x4check3`. Same steps and pass criteria: approve the `ask_user` question, deny the tool request. To see the allowed half, answer Allow once on one of the two and check the call ran.
5. If a ruled call runs without a request, V1.10 is not deployed on staging or the rule key does not match: compare the key in the approval card of a run that does ask (the card shows the tool key) with the list in step 4 of the setup.
