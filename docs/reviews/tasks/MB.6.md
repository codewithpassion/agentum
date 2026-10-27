# MB.6 review: mobile library file panel and skills index

## Findings in scope

- F-17 fixed. Tapping a file on a phone (below 768px) scrolls the file panel to the top of the screen once the file has loaded (`library-file-panel.tsx`). The scroll waits for the load because the page is too short to scroll before it. File and folder links and wiki tree rows are 40px on phones. Desktop is unchanged.
- F-21 fixed. On phones the skills list comes first, and the new skill, upload and GitHub import forms sit behind one "Add skill" button (`skills.index.tsx`). From md up the button is hidden and the forms show as before. Skill rows are `max-md:min-h-10`, which is already met by their padding.
- Wiki page view and library history panel, checked with a locally created wiki page and a two-version file at 390x844. Both fit with no sideways scroll (document width 390). The compare diff scrolls inside its own box. No change was needed.

## Screenshots

In `docs/reviews/tasks/MB.6/`: `skills-390-closed.png`, `skills-390-open.png`, `skills-1280.png`, `wiki-390.png`, `file-390.png`, `hist-390.png`, `lib-1280.png`.

## Review rounds

Round 1 (4bc6797): the only must-fix was this missing file, written now. Code had no must-fix.

## Nits left

- The skills screenshots show an empty list, because creating a skill locally needs a valid SKILL.md flow I did not pursue. The 40px skill row was not seen in a browser.
- The Download button on a skill row stays `sm`. On touch devices MB.1's global rule lifts it to 40px.
- The file panel does not scroll to a failed read's error message.
- The scroll also runs when a wiki page opens its editor panel, where it is harmless.
- History checkboxes are 16px visually. MB.1's rule gives them a 40px hit area on touch devices.

## Ideas beyond scope

- Scroll the wiki page view into view when a wiki tree row is tapped on a phone, as the file panel now does.

## Steps for Dom

None.
