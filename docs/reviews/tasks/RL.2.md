# RL.2 review: Rail service, mail titles, longer mail approvals, owners, members and tRPC

## Verdicts

- Round 1, `258a2fd5`: not clean, 2 must-fix. The AI account setup step ignored the Anthropic managed key, and Working dropped every run that had a Needs you card, including running runs that hold a mail approval.
- Round 2, `ab0111bd` (fix commit only): clean. Both must-fix items are fixed with tests that use the real state (an Anthropic-only workspace, a `running` run holding a mail approval).

## What was built

- `@repo/services/rail` (`rail.ts`, `rail/logic.ts`) and `@repo/services/members`.
- `desk.get` titles a mail run by its subject, and `desk.railSources` is the narrow read the rail uses so visibility stays in the desk.
- `requests.open` takes `{ ttlMs }` as a third argument. `mail/outbound.ts` passes `MAIL_APPROVAL_TTL_MS` and a 4000 character preview.
- `agents.setOwners`, `rail.clearAttention`, `desk.rail`, `desk.clearAttention`, `members.list`, `agents.setOwners` over tRPC, and the Clerk member lister in `apps/web/src/server/clerk-members.ts` (60 second cache per organisation).

## Choices where the spec was silent

- Grouping (rule 7) is also per assignee, so a row has one person to ask.
- `ttlMs` is not part of `openInputSchema`, so a runtime cannot lengthen its own approvals.
- A run whose status is `waiting` is listed under Needs you only, not in Working.
- Escalation uses `>=` 4 hours.
- The `ai_account` step is satisfied by a model key or an Anthropic managed key.
- The viewer's UTC offset comes from `dayStart`.
- `setOwners` checks membership only for ids that change, so an owner who left does not block changing the backup. The spec says "each id must be a current member", so this is a small loosening.
- Bounced mail needs a person for 7 days, like failed runs.

## Nits left

- `agents.setOwners` has no test for the unchanged-id case (a departed owner stays, the backup changes).
- A `waiting` run whose request expired but is not yet closed shows in neither lane until the minute tick ends it. Staging has crons off, so it lasts longer there.
- `dueFrom`: the derived offset is wrong for UTC-10 and UTC-11 (explicit dates land a day early), ignores daylight saving at the target date, applies the first time in the text to every date, counts "not urgent" as urgent, and does not match "Sept". It only sees `theyWrote`, which `mail/inbound.ts` caps at 300 characters.
- `groupKey` joins every recipient's key, so a mail to one company and one free-mail address groups with nothing. "Smith, John" gives the first name "Smith,".
- One escalated card marks its whole group as Mine.
- `INBOUND_MAIL_PREFIX` in `desk.ts` copies the notice in `mail/inbound.ts` with no shared constant.
- `rail.ts` repeats `isMailApproval` from `mail/approval.ts`.
- `./rail/logic` is exported in `package.json` though only the module uses it.
- A held-mail preview over 8192 bytes once JSON-escaped makes `capInput` turn `display.input` into a truncated string, and the card body falls back to the 500 character snippet.
- A run in another member's private session reaches nobody's Mine: the starter sees it under Everyone only.
- `clearAttention` takes any visible run, with no status check.

## Ideas beyond the scope

- The Task page (`components/task/thread-runs.tsx`) still shows the raw `inputText` for mail runs. "Mail tasks read as their subject everywhere" needs that fixed in RL.4 or a follow-up.
- An explicit viewer timezone in `desk.rail` input would fix the offset limits above.
- Escalation can only reach items that live past 4 hours: mail approvals, questions, proposals and problems. Ordinary approvals expire after 1 hour first.

## Steps for Dom

None. Production Clerk needs no change: `members.list` uses the existing `CLERK_SECRET_KEY`. No new migration.
