# TX.6 review: decision queue and team diary in Slack

## Verdicts

- Round 1 (cfb8d31c): not clean. Two must-fix in the diary job: a 50-run candidate limit that starved later teams, and a duplicate check that compared untrimmed text with the trimmed stored post.
- Round 2 (03fcec97): not clean. Removing the limit left the duplicate-check query able to pass D1's 100-parameter limit.
- Round 3 (36924f56): clean. The query now reads team ids in batches of 50, and a whitespace-only diary is skipped.

## What changed

- A decision queue posts as one Slack message with a button row per question (`slack/request-cards.ts`). A click answers that question through `requests.answerDecisions(..., "slack")` and redraws the message. A question that already has an answer ignores later clicks. The last answer settles the card through the existing `request.answered` event.
- The team diary no longer posts at dream time. A minute tick job, `dream.postDiaries`, posts it at the first 08:00 in the workspace timezone after the dream finished, as the lead (or the system without a lead). The room post reaches the linked channel through the existing room-out path. A diary more than 12 hours past its slot is dropped. A diary already in the "Team diary" topic is not posted again.
- No schema change. "Already posted" is read from the topic's posts.

## Behaviour worth knowing

- The diary moves to 08:00 for every team, not only Slack-linked ones, because the room post is what reaches Slack. A manual "dream now" posts its diary at the next 08:00.
- Undoing a team dream before its 08:00 slot means that day's diary is never posted.
- The hand-off requests to the lead still post at dream time.

## Nits left

- No test for a whitespace-only diary, or for the duplicate check across more than 50 due teams.
- `dream_runs` has no index on status or finished_at; the minute query scans it.
- Two people clicking different options for one question at the same instant can overwrite each other (best effort guard).
- A redraw racing a closing click can briefly show a stale card; the next click or event fixes it.
- `requestCard(request, settled)` takes a bare boolean while `decisionsCard` takes an object.

## Ideas beyond scope

- A partial answer on the web does not redraw the Slack card; only the final answer settles it.
- A free-text decision can only be answered in Agentum; Slack shows a hint.

## Steps for Dom

None. No new secrets or Slack scopes. To see the diary timing live, link a team to a Slack channel and wait for the 08:00 tick after a team dream.
