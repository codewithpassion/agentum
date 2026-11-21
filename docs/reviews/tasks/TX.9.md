# TX.9 review

## Verdict
Round 1 (d128dc6b): clean, no must-fix. No fix rounds.

## Nits left
- No test covers the team branch of the rail title (`rail/logic.ts`, `rail.ts`).
- No component test renders the team heading in `needs-you-card.tsx`.
- The doc comment on `NEEDS_YOU_HEADINGS` still says the heading comes from the agent's name only.
- `desk.ts` uses `row.teamId ?? ""` as a lookup key; a null check would read more directly.

## Beyond the scope
The rail title also names the team now, through the same heading function.

## Skipped
Browser step (the Needs you pane): skipped, Dom moved browser checks to one pass at the end of v4.

## Steps for Dom
None. In the v4 browser pass, check a team question's Needs you card reads "<Team> has a question from its team dream".
