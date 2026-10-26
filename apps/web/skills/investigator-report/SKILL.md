---
name: investigator-report
description: Use at the end of every investigation run to report the outcome to control-plane.
---

# Investigator report

The trigger prompt names an incident id that starts with `inc_`. Investigate the incident as the prompt says.

At the end of every run, report once. This includes runs where you could not finish, hit an error, are missing a tool or access, or are unsure of the result.

To report, run `scripts/report.ts` once with `run_skill_script`. Pass one argument, a JSON string in this shape:

`{"incidentId":"inc_...","outcome":"fixed","summary":"one paragraph for a human","steps":["what you checked","what you changed"]}`

Rules for the fields:

- `incidentId` is the id from the trigger prompt.
- `outcome` is `"fixed"` only when you verified the problem is gone. In every other case, including any failure, use `"escalate"`.
- `summary` is one paragraph for a human reader. Say what happened and what the next step is.
- `steps` lists what you checked and what you changed, one item per step.
- Never put a token or any other credential in `summary` or `steps`.

If the script exits non-zero or prints a line starting with `report failed`, your first sentence in the final answer says that posting the result to control-plane failed, and gives the reason. Control-plane escalates on its own after a timeout. Do not retry more than once.
