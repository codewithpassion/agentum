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

## Real-model check

Flow 1 ran against `claude-haiku-5-5` with the dev key, held in a shell variable and never written to a file or the database. It ran the dream's own steps (extract, merge, reconcile) on a person-written `people` note ("Client lunches with Northwind are on Fridays at 1pm.") and one conversation saying the lunch moved to 1:30pm. Extract wrote a `work` candidate. Merge dropped the `people` note and added the `work` note "Northwind client lunches are on Fridays at 1:30pm (moved from 1pm as of 2026-11-20)." Reconcile found nothing. One note is left, with the newer kind, and no model call failed. Cost: $0.00018 (766 in, 211 out). Not run through the browser or the dream tables; the steps are the dream's whole model work.

## Steps for Dom
None.
