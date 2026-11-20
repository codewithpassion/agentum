# TX.4 review

## Verdict per round

Round 1, commit 2dce3e9b: must-fix. `listPending` passed a null masker although a pending decision queue holds partial answers. A person's cancel of the run left its card open, and a later answer or the 24-hour sweep would have started a follow-up from the cancelled run.
Round 2, commit 8f8acb6c: must-fix. The "same card" lookup matched on session and agent, so a later run was handed an older run's open card and its cancel did not close it.
Round 3, commit e9d05355: must-fix. The fix (lookup on run id) was right, but its test started the second run in a new session and passed without it.
Round 4, commit 04de528b: clean. The test now starts the second run in the first run's session, fails against the old lookup and passes against the fix.

## What was built

- `requests.openDecisions(principal, { runId, questions })` raises up to eight questions (two to four options, optional free text) as one `decisions` request. Ids are `q1` to `q8`. It returns at once. The request is detached (`isDecisionsRequest`, in the SQL twin `notDetachedApproval` too), so the run is never parked and a run ending leaves the card open. The same questions raised again by the same run while the card is open give the same card. A run that cannot take a follow-up (dry run, app or A2A reply, guest, hand-off child, subagent, peer-rooted, artifact session) is refused with a conflict. `runTakesFollowUp` in `runs/deferral.ts` is the shared rule, and `runDefersQuestions` now calls it after its machine check.
- `requests.answerDecisions` takes partial answers. Each answer is an option or, where the question has `freeText`, typed text (at most 4000 characters). A later answer to a question replaces the earlier one. The write is conditional on the answers it read, so two members answering at once both land and only one write closes the request. The row closes (`answered`) on the last answer, and the follow-up starts.
- `requests.dismissDecisions` cancels the row, keeps the answers given so far on it, and tells the agent nothing.
- Expiry (24 hours, the `expireDue` sweep) closes the row `expired` with the answers so far and wakes the agent. `outcomeOf` leaves the partial answers out of an expired or cancelled outcome.
- The follow-up is `startFollowUp` (shared with the NV.4 parked-question path): a run in the same session, with the run's actor, delegation and reply target, request id `question-answer:<request id>` so it starts once and the pause hold lets it through. Its text is a fixed line, then one `<question>: <answer>` line per question, with `no answer` for an unanswered one. Lines are masked and line breaks are folded.
- A run that a person cancels also cancels its pending decision queues, and a cancelled run is never woken.
- `ask_decisions` is a platform MCP tool (`packages/mcp/src/tools/decisions.ts`) for run principals, bound in `apps/web/src/server/mcp/decisions-ports.ts`. A lead in its team room keeps it. A read-only server does not offer it.
- The request reaches `desk.railSources` as a Needs you card of kind `decisions` titled "N decisions" (`desk-decisions.test.ts`).
- KY.15 is untouched: `setRule` and `removeRule` stay owner-or-admin, and `recordAlwaysAllow` stays on the any-member answer path.

## Decisions made

- Dismiss sends the agent nothing, so it cannot loop by asking again at once. The agent learns only when it next looks. If Dom wants the agent told, add a wake line for a cancelled queue and say in it not to raise the questions again unprompted.
- A partial answer writes no event. The row carries it, and a client reads it from `listPending`. `request.answered` stays "closed" for every listener.
- `answeredVia` is always `web`. TX.6 must pass the surface through when Slack answers.
- Duplicate cards across two runs of one session are accepted: the lookup is per run so a run's cancel can close its own card.

## Nits left

- `answer` still builds the session-visibility and guest-run write condition inline, where `answerableBy` now exists for the new methods. Left alone because `answer` carries the KY.15 path.
- `listPending` calls `maskerFor` once per row that holds answers, with no per-agent cache.
- Two concurrent identical `ask_decisions` calls from one run can both pass the lookup and raise two cards.
- The follow-up starts after the closing write with no reconcile sweep. If the Worker dies between them, the answers stay on the row and nothing reaches the agent.
- The wake text is masked with the agent's masker only, not `redactText`, as `questionWakeText` already is.
- Options are not trimmed on open, so an option with a trailing space (only possible outside the MCP tool) cannot be picked, because answers are trimmed.
- The run receipt (`tasks/receipt.ts`) shows a decisions `request.opened` as a paused "Approval required" step although the run is not held.
- The `ask_decisions` description names fewer refused run types than the code does.
- The `request.answered` event of a completing answer between a cancel's status write and its decision cancel leaves the card `answered` with no follow-up, and no sign of that.

## Beyond the scope

- TX.5 reads `record.answer` (partial answers) for its "3 of 5 answered" progress and calls `requests.answerDecisions` and `requests.dismissDecisions`.
- TX.6: the Slack card builder still throws for a decisions display, so every decisions open in a Slack-linked workspace logs "Slack request card failed". It also has to call `answerDecisions` with `via: "slack"` once that is a parameter.

## Steps for Dom

None.
