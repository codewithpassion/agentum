# SL.6 review

Task SL.6, a fake runtime that asks for approval in a room.

## Verdict

Round 1: clean, no must-fix. Opus reviewer at 56cae3e.

## What was built

A task text with `ask:<tool>` makes a fake run open an approval request for that tool and wait. When the request closes, the adapter's `resume` ends the run with "Allowed <tool>." or "Denied <tool>.". `RuntimeAdapter.resume` now receives the adapter deps. The app passes `askApproval` from `compose.ts`, which reaches the requests service lazily. The mode exists only when `devFakeRuntime` is true.

Browser check, done: in a linked room, `@ada ask:send_email` put an approval card in the fake Slack thread. Allow once settled the card ("Allowed once on Slack"), the request closed as answered via Slack, and Ada replied "Allowed send_email." in the thread.

## Nits left

- The marker regex has no word boundary, so `task:x` also matches. The `tool:` marker has the same flaw.
- An expired or cancelled request reads as "Denied".
- Always allow stores a rule the fake never reads, so the next `ask:` run asks again.
- No test for a retried dispatch opening a second card (the fixed tool use id covers it).
- The test copies the app's `askApproval` lambda.

## Ideas beyond scope

A second marker for `ask:` with a question, to show a question card in Slack.

## Steps for Dom

None.
