# RL.7 review

## Verdict

Round 1, commit 7590e970: clean. No must-fix findings.

## Nits left

- `packages/db/src/shared.ts` (`theyWrote` comment) and `docs/ux-review/rail/spec.md` (line 51) still say the message is on the same thread. It can now come from the run's own inbound mail.
- `docs/ux-review/rail/spec.md` (line 119) still says `Reply to <first name or address>`. A nameless address now gives words from its local part.
- The new-thread service test uses a fixture where the inbound sender is the same as `to[0]`. No test covers a reply to someone other than the sender, or a new-thread approval whose run has no inbound mail.
- Splitting the local part on every non-letter gives `Jane Invoices` for `jane+invoices@` and `O Brien` for `o'brien@`. The task lists neither form.
- `new Set` around `bareRuns` in `rail.ts` is redundant, `inBatches` already removes duplicates. It matches the call beside it.

## Beyond the scope

- An HTML-only inbound mail stores an empty snippet (`mail/inbound.ts`), so `theyWrote` is an empty string and `mail-decision.tsx` shows an empty `They wrote` quote, because it only checks for null. This predates RL.7 and can still produce the acceptance symptom. It may deserve its own task.
