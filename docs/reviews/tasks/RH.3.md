# RH.3 review: Home page, the agent card wall

## Verdicts

- Round 1 (fddb80d): clean, 0 must-fix.
- Browser proof (f8bbb31): pass at 1280x800 and 390x844. Report and screenshots in `docs/reviews/tasks/RH.3/browser.md`.

## Browser check notes

- The state sort was proven with a mocked `roster.list` response, because `roster.list` is still the RH.1 stub (every agent idle, empty owner) until RH.2 merges. The real, all-idle response is shown in flow 3. Re-check the sort on real data after RH.2.
- Needs you chips ran on real data (a pending wiki suggestion seeded in local D1). Its pane says "Suggestion bytes not found" only because the seeded row has no stored blob.

## Nits left

- The signed-in landing is the only redirect moved. `picker-redirect.ts`, `use-switch-workspace.ts` and `accept-invitation.tsx` still send people to `/desk` after choosing or switching workspace or accepting an invitation. The scope names only the landing.
- Home runs `useRail` while the rail also does, so `desk.rail` is polled twice every 10 seconds on `/home`. RH.6 replaces the rail.
- A failing `roster.list` poll shows nothing: the old cards stay.
- The chip builds `/desk?item=<id>` itself, as `rail-needs-you.tsx` does. A shared helper would keep them together.
- The card prints "Owner" with no name while the stub returns an empty owner. RH.2 fills it.
- The empty-job-line test in `agent-card.test.tsx` asserts on a class string, so a style change can break it.
- The card text spans were changed from `<p>` to `<span className="block">` after the review, to keep valid HTML inside the link (f8bbb31). Component tests and `bun run check` pass.

## Ideas beyond scope

- Group the wall by team once TM lands (the mockup shows team headers).
- Show an error banner when the roster poll fails.

## Steps for Dom

None. No account or dashboard steps.
