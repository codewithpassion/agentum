# RH.7 review: Roster walkthrough on local and staging

## Verdicts

- Browser proof, round 1 (a35052b2 plus no code change): pass at 1280x800 and 390x844, all eight flows, no failed request, no app console error. Report and screenshots in `docs/reviews/tasks/RH.7/browser.md`. A fresh verifier ran it.
- Code review, round 1 (5b201fe9): clean, 0 must-fix, 11 nits.

The browser proof ran before the two small fixes (job line ellipsis, hidden empty owner label). Both are covered by service and component tests and were not walked again in a browser.

## Findings and where they went

`docs/reviews/RH-e2e.md` holds the result per flow, what was fixed, and four proposed tasks: one avatar everywhere, one time zone rule, the Find dialog's stray heading, and fail-fast on a Cloud run whose `PUBLIC_BASE_URL` points at another port.

RH.3's open item is closed: the state sort matches the rule on real roster data in all four states.

## Nits left

- `SENTENCE_END` does not treat `]` or `»` as a closing character.
- A clipped job line is cut mid-word with an ellipsis. The room header cuts at a word boundary.
- `agent-card.tsx` leaves an empty `<span>` in the DOM when there is no owner.
- browser.md cites `tmp/RH.7/check.js`, `roster.js` and `dev-1.log`, which are not committed.
- browser.md's screenshots are not all in flow order (desktop-8 shows Long-Form Blog Writer "working" after flow 5 shows it finished).
- A failed run is a Needs you chip but is left out of the card's `needsYouCount`. This is by design; browser.md does not say so.

## Ideas beyond scope

- Pick Cloud as the builder's default runtime on local, since managed needs a tunnel.

## Steps for Dom

- After deploy, repeat the walkthrough on staging with a real member, including an agent on the Anthropic cloud (managed) runtime.
- Decide the time zone rule (second proposed task in `docs/reviews/RH-e2e.md`).
