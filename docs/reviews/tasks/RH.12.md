# RH.12: a live run never reads Idle on a card

## Choice recorded for RH.2's log

`needs_you` follows the RH.2 task file: an open request that names the agent's owner or backup, the same on everyone's card. `roster.list` asks the rail for the "everyone" scope, which keeps the private-session rules, instead of the viewer's "mine" scope. RH.2's task file is the controller's to edit, so the line for its log is: "2026-11-20: RH.12 settled that `needs_you` follows this file, not the viewer's own Needs you list."

Also changed: a `waiting` run with no visible wait reads `needs_you` ("Waiting on <owner>", or "Waiting on a person"), and a `queued` or `offered` run reads `working` ("Queued", "Starting"). The roster's run query now loads every live run, so an old waiting run still counts.

An existing rail test asserted the old behaviour (a backup before escalation saw "Idle"). It now expects `needs_you`.

## Review

Round 1, commit 352d4ce0: clean, no must-fix.

## Nits left

- roster.ts:105: the comment above `STARTING_STATUSES` describes `runFacts`.
- roster.ts:510: "Waiting on <name>" always names the owner, even after escalation to the backup.
- roster.ts:262: a waiting run now ranks ahead of a newer failed run. No test pins this.
- team-group.tsx:24: the team header counts everyone's requests under "N need you".

## Ideas beyond the scope

- Name the person actually asked (owner or escalated backup) in "Waiting on ...".

## Steps for Dom

None.
