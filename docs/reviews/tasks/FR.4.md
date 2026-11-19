# FR.4 review: Templates gallery

## Verdict

Round 1, commit f41f480c: must-fix, one item. A template could be picked while dictation into the describe box was running, and the dictation result then landed on the template text.

Round 2, commit a24723ab (the fix commit only): clean, nothing must-fix. One fix round.

After round 2 the browser verifier failed its first run: Create agent stayed disabled on a workspace with no Anthropic key, although the panel says you can still create without one. The dry-run blocker was also blocking Create. Commit d7bd2bad fixes it and adds `dry-run-panel.test.tsx`. The second browser run passed.

Round 3, commit d7bd2bad (reviewed after the coordinator asked): clean, nothing must-fix. The reviewer confirmed that dictation, pending and open gaps still block Create, that the name and "does" checks still do through the route's `createBlocker`, and that the server `create` needs no key or dry run. The new test fails on the old code.

Checks: `bun run check` and `bun run build` pass. `bun run test` passes everything (4380 web tests) except `guest execution: HTTP cap/start, durable recovery, signed MCP and suggestions` in `apps/web/src/server/live-artifacts/guest-execution.test.ts`. That test fails alone and on a clean `main` checkout too, with a workerd `ECONNRESET` from Miniflare, so it does not come from this task. FR.1's review recorded the same test failing.

Browser proof: `docs/reviews/tasks/FR.4/browser.md`, pass at 1280x800 and 390x844.

## What was built

- `components/agent/builder/template-gallery.tsx`: a "Start from a template" grid, one card per template with its title and the first sentence of its description. `template-gallery.test.tsx` covers the cards, the click, the disabled state and the first-sentence helper.
- `/agents/new` shows the gallery above the describe box until a draft exists. A click calls `agentBuilder.fromTemplate` (no model call), loads the draft into the review screen, and sets the description, voice and template id so Redraft starts from the template.
- The old template chips under the describe box are gone, since the gallery replaces them. "Import from a file" stays, under the label "Or import".
- Create agent no longer waits on the dry-run blocker. A missing Anthropic key stops only the dry run, and the note under the buttons says so. Name and "does" checks (`redraftBlocker`) still block Create.

## Not done, by scope

- Team starters in the New team dialog: FR.2 has not shipped.
- The home page "Start from a template" card: it belongs to RH.3 and does not exist yet. It should link to `/agents/new`.

## Nits left

- Round 3: the comment above `const why` in `dry-run-panel.tsx` describes the Create button, not `why`. The `create-why` test id can now hold a run-only reason. Only the first reason shows, so an open gap hides the missing-key hint. The `redraftBlocker` messages say "before you redraft" when they now also explain a disabled Create.
- Round 3: `dry-run-panel.test.tsx` passes vacuously if its button regex stops matching, copies the key note instead of importing it, and does not check that Run is disabled. No test covers the route's Create-blocker wiring.
- Picking a template replaces whatever the person typed in the describe box, as the old chips did.
- The gallery hides once a draft exists, so switching template means Discard first, which leaves the page.
- A failed `fromTemplate` shows its error in the describe panel's slot, not next to the gallery.
- No test covers the route wiring (pick calls `fromTemplate`, fills the review screen) or the dictation guard. The browser proof covers the first.
- `template-gallery.test.tsx` casts the happy-dom container with `as unknown as Element`, as other happy-dom tests in the repo do.
- The busy condition order differs from other guards in the file (`busy || dictating` against `dictating || busy`).
- On a phone the Address input clips long addresses visually. The stored value is complete.
- A fresh workspace with no runtime still needs a runtime picked before Create opens ("Where it runs" gap). FR.1 left the template runtime null on purpose.

## Beyond the scope

- Apply a template's ask level, job sentence and remember list at create (see FR.1's review).
- Keep the gallery reachable after a draft appears, as a collapsed row, so a person can swap templates without losing the page.

## Steps for Dom

None.
