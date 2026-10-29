# LR.18 review: Create document from the artifacts page

## Verdict

Round 1 at 8db193de: clean, no must-fix findings. No fix rounds.

## Decisions

Create document sits next to Create deck on `/artifacts` and copies its flow: a title field, then `liveArtifacts.createDocument`, then navigation to `/a/$artifactId`. Neither form has permission gating in the UI. Both procedures are `workspaceProcedure`, so the page's existing rule applies and nothing was added.

The artifacts page has no delete or archive action for decks or documents, so none was added.

The test covers the markup and the create-then-open logic (`createAndOpenDocument`). It does not drive DOM events, because react-dom fixes `canUseDOM` at import time and input events stop working once another test file has loaded react-dom.

## Browser check

Local dev, 1280x800 and 390x844: created a document, landed in the editor, typed text. Both Create buttons measure 42px tall at 390px and fit the viewport.

## Nits left

- The form duplicates `live-decks/create-deck.tsx`. Extract a shared form if a third kind appears.
- Raw `<input>` and `<button>` with hand-written classes, as in CreateDeck, not the shadcn Button.
- The `CreateDocument` wiring (procedure call and navigate) is untested. Types cover most of it.
- Static markup assertions for `disabled` and `min-h-10` are loose.
- A navigation failure shows as a create failure and re-enables the form, so a retry can create a duplicate. CreateDeck behaves the same.

## Ideas beyond scope

- Delete or archive for decks and documents on the artifacts page.
- A shared "create artifact by title" form with shadcn components.

## Steps for Dom

None. Local runs need `ARTIFACT_VIEW_KEY` in `apps/web/.env.local`, which the main checkout's file lacks.
