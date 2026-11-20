# DR.9 review

Round 1 (0bae9bad): must-fix. The judge prompt said a correcting note groups with the note it corrects, and also that notes that disagree go in no group. The real-model walkthrough had no evidence.
Round 2 (40157096): clean. The prompt now leaves only disagreements with no sign of correction out of groups. Stale header comments fixed.

## Nits left
- Edited header comments run longer than the surrounding 80-column wrap (merge.ts:5, merge.test.ts:2, groups.ts:1).
- Merge verdicts with no candidate now also merge existing notes across kinds. The kind comes from the note with the latest date, and a date tie picks the first note listed. No test covers it.
- One judge call per scope now holds every kind, so a null answer skips the whole scope.
- The drop of the old note and the add of the corrected one are not linked in the memory log (no shared groupId).
- `replaceOtherKinds` has an unreachable `!newcomer` guard.

## Beyond scope
- Reconcile still groups by kind and scope, so a cross-kind disagreement with no correction word is not compared (DR.10 covers the extract side).

## Steps for Dom
- Repeat the walkthrough's flow 1 with a real model (a people note says 1pm, a conversation says it moved to 1:30pm), then read the notes list. This needs the live API key and a browser; the fake-model service test passes.
