---
name: investigator-report
description: Use in every investigation run to post each step as you go, stay inside the approval limits, and report the outcome to control-plane.
---

# Investigator report

The trigger prompt names an incident id that starts with `inc_`. Investigate the incident as the prompt says. Control-plane starts you on its own, with no one clicking approve, because everything you do is visible. People follow your run on the incident timeline and in Slack, so post what you do and stay inside the limits below.

## Post each step as you go

Before each thing you check or change, run `scripts/step.ts` with `run_skill_script`. Pass one argument, a JSON string:

`{"incidentId":"inc_...","text":"what you are about to do or just found, in one sentence"}`

Post a step for every check, every retry and every re-run, in the order you do them, not all at once at the end. Keep each under 500 characters. Never put a token or any other credential in a step. If the script prints a line starting with `step failed`, carry on with the investigation. Do not retry a failed step more than once.

## What you may do on your own

- Read: logs, job and workflow status, configuration, dashboards, mailbox and chat history.
- Retry a failed job.
- Re-run a workflow.
- Run this skill's scripts. Posting to control-plane through them is the only post you may make without asking.

## What needs Dom's approval first

- Any change to configuration, settings, environment variables, secrets, tokens or other credentials, including creating or editing skills, triggers, routines and agents.
- Anything that sends email.
- Anything that posts or sends a message anywhere else, such as Slack, the inbox or another agent.

Some of these tools have an "Ask me before" rule on your agent. When you call one, the platform pauses the run and asks Dom, and your call returns only after he answers. Post a step first, such as "Asking Dom to approve sending the customer email", so the timeline shows why the run is waiting. A tool with no rule is not permission. For an action in the list above whose tool has no rule, use the `ask_user` tool and wait for the answer before you act.

If Dom denies a call, it expires or it is cancelled, do not try again and do not find another way to get the same result. Report `escalate`.

If you need approval and have no `ask_user` tool, do not act. Report `escalate` and say what you would have done.

## Report at the end

At the end of every run, report once. This includes runs where you could not finish, hit an error, are missing a tool or access, or are unsure of the result.

To report, run `scripts/report.ts` once with `run_skill_script`. Pass one argument, a JSON string in this shape:

`{"incidentId":"inc_...","outcome":"fixed","summary":"one paragraph for a human","steps":["what you checked","what you changed"]}`

Rules for the fields:

- `incidentId` is the id from the trigger prompt.
- `outcome` is `"fixed"` only when you verified the problem is gone. In every other case, including any failure, use `"escalate"`.
- `summary` is one paragraph for a human reader. Say what happened and what the next step is.
- `steps` lists what you checked and what you changed, one item per step, in order. Include every step you posted, and any approval you asked for with its answer.
- Never put a token or any other credential in `summary` or `steps`.

If the script exits non-zero or prints a line starting with `report failed`, your first sentence in the final answer says that posting the result to control-plane failed, and gives the reason. Control-plane escalates on its own after a timeout. Do not retry more than once.
