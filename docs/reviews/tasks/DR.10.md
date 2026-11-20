# DR.10 review

Verdict: round 1 at 508fd45a, clean. No must-fix.

## Real-model run

Two conversations that disagree (supplier invoices paid on Thursdays, then on Fridays), through the real `claude-haiku-5-5`. The extract step wrote two notes, one per side, with no "previously noted" or "unclear" wording. One dream cost $0.0003 (about 1,300 input and 300 output tokens). A second dream gave no question, which is DR.16's gap: reconcile never sees notes a dream just added, and skips groups made only of dream-written notes.

## Nits left

- The prompt bans "confirm" and "check with" outright, which could reword a real standing preference such as "Check with Mia before booking travel".
- The "stay two candidates" test passes a fake model's two notes through, so it would pass on the old prompt too.
- The prompt test checks substrings, so it guards the text being present and not its meaning.

## Beyond scope

DR.16: let reconcile judge new candidates, or loosen the dream-only skip, so a disagreement ends in a question in Needs you.

## Steps for Dom

None.
