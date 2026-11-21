# TX.7 review: team extras walkthrough

## Verdict per round

Round 1, commit 27425fe7: clean. Nine nits, all applied in b5f4fef0 (wrong lead name in one row, cost total, TX.9 and TX.10 scopes, the run-again steps and the pause comment in `team-propose.ts`).

Browser proof, commit b5f4fef0: every flow ran at 1280x800 and 390x844 on a clean database and worked. The verifier marked it a fail on the strict console rule because of `database is locked` 500s that came while a script or a `sqlite3` read touched the database file. A control run with nothing else on the file was clean. The dispatcher ruled them tool noise, as TM.10 did, and recorded that in `docs/reviews/tasks/TX.7/browser.md`.

## What changed

- `docs/reviews/TX-e2e.md`: the walkthrough result, five proposed tasks (TX.8 to TX.12), things to know and the steps to run it again.
- `scripts/dev/team-propose.ts` waits eight seconds before it puts the run back, so its write no longer races the Slack card the server posts after the tool call.

## Nits left

- The walkthrough's lead hit its 10 wakes an hour twice, so the hand-off passes used fresh fake agents.
- Screenshots desktop-12 and desktop-14 were dropped by the verifier, so the numbering has gaps.
- The strict browser rule cannot pass while the helper scripts write to the local database. A helper that goes through the app would fix that.

## Ideas beyond the scope

- TX.8 to TX.12 in `docs/reviews/TX-e2e.md`.
- A scripted lead for the fake runtime (TM.14 asked for it), so `team-propose.ts` can go.

## Steps for Dom

None need his accounts or dashboards.
