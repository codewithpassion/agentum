---
id: X.4
title: Investigator runs are visible and stay inside the approval guardrail
milestone: X
size: S
status: in_progress
depends_on: [X.3]
branch: task/X.4-investigator-visibility
lane: services
executor: claude
---

Dom decided (26 Oct 2026) that control-plane starts the investigator automatically, with no approval click, as long as everything it does is visible. control-plane posts the start, each step and the outcome to Slack and to the incident timeline. This task is the Harbourmaster side and extends X.3. The contract is C3 in `~/devel/ai-os-integration/CONTRACTS.md`.

## Scope
- The investigator logs each step as it goes and posts it to control-plane `POST /ingest/events` as `investigation.step` `{ incidentId, runId, text }` (source "agent", correlation_id = incident id). Its final `investigation.result` carries the full `steps[]`.
- The run started by the trigger is reachable by link: the trigger response's `runId` and `sessionId` must open a page a signed-in member can read. control-plane builds the link from the trigger URL's origin, so say in this file which path that is.
- Guardrail in the investigator's instructions and tool permissions: it may read, retry jobs and re-run workflows on its own. Any change to config or credentials, and anything that sends email or posts, must go to Dom first through V1's ask/approval flow ("Ask me before"). If V1 approvals are not live yet, it escalates instead of acting.

## Check
- A staging run started by the trigger posts at least one `investigation.step` and one `investigation.result` to control-plane staging, and the incident timeline links back to the run.
- An attempt to send mail or change a secret during a test run produces an approval request (or an escalate), not the action.

## Log
- 2026-10-26: requested by the integration coordinator after Dom's decision on auto-start with visibility.
- 2026-10-26: dispatched. Its staging check also covers X.3's; controller runs it after merge.
