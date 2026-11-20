# KY.12 review: the catalogue on Settings, Apps

## Verdicts

- Round 1 (b0b0f54): clean. No must-fix.

## Browser check

Pass at desktop (1280x800) and phone (390x844). Report and screenshots in `docs/reviews/tasks/KY.12/browser.md`. As admin, Linear added from Settings, Apps showed as a row, left the catalogue menu, and sat under "Already in this workspace" on the Keys tab. The Keys tab menu still adds catalogue apps.

## Nits left

- After a catalogue add, the page says only "Added X." The "Add connector" path adds an auth hint and opens the OAuth client dialog when the server cannot register a client. A catalogue add skips both, so an OAuth app that needs a client shows "needs auth" with "Set client" in its row.
- The empty state still says "No connectors yet. Add one by URL." It now sits under the catalogue picker for admins.
- The option group "From the catalogue" repeats the heading "Add from the catalogue" on Settings.
- The browser verifier seeded one fake agent into the local D1 because the UI refused a fake Anthropic key. Desktop network checks relied on the console, not a request log.

## Beyond scope

- Run the OAuth client prompt (`needsClient`) after a catalogue add, as the URL path does.

## Steps for Dom

None.
