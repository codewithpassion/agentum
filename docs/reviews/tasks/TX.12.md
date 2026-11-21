# TX.12 review: one diary post per team per morning

Round 1 (436af411): clean. No must-fix.

Nits:
- The `sent` set in `postDue` became redundant once `dueRuns` returns one run per team and slot. Removed in the follow-up commit.
- If the newest done dream for a slot has an empty diary, `readCandidates` drops it and an older dream's diary posts instead. Left as is: an empty diary has nothing to post.

Ideas beyond scope: none.

Steps for Dom: none.

Browser steps skipped: none were in the task's check.
