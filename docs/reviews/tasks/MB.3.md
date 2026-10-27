# MB.3 review: mobile agent profile and its sheets

Status: in progress (checks pass, reviewer pending).

## Fixes
- F-04: chips wrap (`whitespace-normal`, break anywhere) below md and keep `nowrap` at md and up. Docwidth is 390 at 390 and 360 at 360.
- F-05: rows stack label over value below md. "Does" has a Show more / Show less toggle below md. Library paths break after slashes (`<wbr>`).
- F-06: "Always" no longer wraps (`shrink-0 whitespace-nowrap`). Chips and switches get 40px from MB.1's global coarse-pointer rule; not re-implemented here.
- F-10: Hands to rows are at least 40px high on coarse pointers; the checkbox hit area comes from MB.1.
- F-08: Edit sheet has a sticky footer on phones with Save and Archive. Desktop layout is unchanged (Archive stays below, separated by a rule).
- F-09: sheets are full width through MB.1's rule; no element in any sheet overflows 390px. The Skills version select is `max-w-full min-w-0` and 40px high on phones. The secrets and routines tables were handled by MB.2.

## Browser check
Local dev server with dev login, two test agents created through tRPC. Screenshots in `docs/reviews/tasks/MB.3-shots/`: `p390.png` (profile), `sheet-{edit,tools,skills,hands,starts}-390.png`, `profile-1280.png`, `sheet-edit-1280.png`. Not exercised: the Skills version select with an assigned skill (no skills in the local database), a long schedule chip (no routine created).
