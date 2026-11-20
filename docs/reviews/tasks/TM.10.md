# TM.10 review

Round 1 (fa5ba58c): not clean, one must-fix. The findings doc said the lead's proposal card is not shown inline in the room, but `room-requests.tsx` shows it. The verifier most likely looked in a different topic than the one `team-propose.ts` used. Fixed in f69dbdca: the claim was corrected and dropped from the TM.12 scope.

Round 2 (f69dbdca, fix commit only): clean.

Browser proof: `docs/reviews/tasks/TM.10/browser.md`, run by a fresh verifier at both sizes, plus a follow-up round for the hidden topic and hidden task in the UI. It ran before the review. The later commits changed only docs and a dev script.

## Nits left

- `scripts/dev/team-propose.ts` takes the lead's newest inbox run in any topic. Its header says so. A `--thread` option would pin the topic.
- Its restore clears `lease_until` rather than putting the old value back. Only matters if the run was live.
- The explanation that the card sat in another topic was not re-checked (TM.12 check covers it).
- No "lead listens" switch on the team page, only a sentence.

## Beyond scope

TM.12 to TM.16 in `docs/reviews/TM-e2e.md`: proposal card wording, Assigned-to for non-members, a fake lead mode, dictation in the room composer, phone room layout. Plus passing `--autocompact` when Claude Code is 2.1.327 or newer.

## Steps for Dom

None. The task file's log lines (compaction finding, dictation decision) are for the controller.
