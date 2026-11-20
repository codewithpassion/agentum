# DR.12 review

## Verdicts

- Round 0, commit 67e11d1: must-fix, two items. Undo could reject a first-version skill the agent proposed from an ordinary run, because the lookup did not filter on `authorRunId`. Reject unassigned a skill even when another proposal survived the rejection.
- Round 1, commit 5831137: clean. Both items fixed, each with a test that fails without the fix.

## Design

A dream's skill proposal records no dream run, and schema changes are out of scope. Undo finds the night's proposal as the agent's own first version, still proposed, with no author run, created from the dream's start to the next dream's start. Rejecting a skill with no approved version and no other live proposal removes its assignments and writes a `skill.unassigned` event for each.

## Nits left

- The unassign check reads versions before the batch, and the delete only guards against an approved version. A run that commits a proposal in that window could still see the skill unassigned.
- `skill.unassigned` events are written for carriers read before the batch, so a guarded delete could leave an event without a delete.
- Undo withdraws proposals after the memory undo has committed, not in the same batch. A reject that throws leaves memory undone and the proposal pending, and a retry is refused.
- No test for a sibling proposal surviving a rejection.

## Beyond scope

- Undo refuses a dream that changed no memory, so a dream that only proposed a skill cannot withdraw it with Undo.
- Withdrawing uses a plain reject, so the rejected title keeps later dreams from proposing it again, and the diary does not say the proposal was withdrawn (DR.11 covers the card text).
- A dream records no run id on its proposals. Setting `authorRunId` or a dream id column would replace the time window.

## Steps for Dom

None.
