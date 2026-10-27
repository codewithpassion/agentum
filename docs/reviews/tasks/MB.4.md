# MB.4 review

Screenshots are in `docs/reviews/tasks/MB.4/` (390x844, 360x740, 1280x800), taken on the local dev server with seeded data: one waiting run with a question and a tool approval, eight done runs, and a 30-post inbox thread.

## Findings

- F-13: the task composer is sticky at the bottom below md (`StickyComposer`, bottom offset follows `visualViewport` so the on-screen keyboard does not cover it). Buttons are 40px through the MB.1 coarse-pointer rule, the textarea is 16px through the MB.1 rule. The hint reads "Tap Send to send" on `(hover: none) and (pointer: coarse)` devices. Enter behaviour is unchanged.
- F-15: below md the inbox shows the thread list or the open thread, with a "All threads" back link. The thread scrolls to its latest post once on load, and the composer is sticky.
- F-12: receipt bodies get "Show more" below md. Fact chips sit in a two-column grid below md (two rows). The "Desk" breadcrumb and "Stop task" are 40px on coarse pointers. The task title is not expandable: the service cuts it with an ellipsis (`titleFor`), the full text is in receipt step 1, which now expands.
- F-03: desk card titles take two lines below md (the same service cut applies). The Done lane shows five cards below md, then "Show N more". Filter chips and Approve / See changes / Reject are 40px on coarse pointers with wider gaps.
- Request cards: checked at 390x844 in the desk and in the task receipt and thread with a seeded choice question and an approval. They fit, buttons wrap, no sideways scroll at 360 or 390. No change needed.

## Verdicts

Round 1: must-fix. The inbox scroll marker sat above the sticky composer, so the last posts hid behind it (fixed: marker after the composer, `inbox-thread-390.png` retaken), and a viewport-sized composer screenshot was missing (`task-composer-390.png`, composer pinned at the bottom of the Thread card). Nits fixed: `md:z-auto` on the sticky wrapper, `inline-flex` on the Desk link only for coarse pointers, `break-words` on desk titles.

Round 2: clean. Nits left: `task-composer-390.png` is taken at the page end, so it does not prove the pin mid-page. The task thread has its own 60dvh scroll box, so the composer pins only while the thread block reaches below the screen edge.

## Notes

The agent-browser viewport does not report a coarse pointer, so the 40px targets were checked from the CSS rules, not measured.

Nits left: two-column fact chips truncate long values (agent name, cost) on a phone, the full text is in the receipt; the Done lane can show "Show N more" next to the server's "+ M more" line; the keyboard-inset hook is untested on a real device; `useCallback` on `nameOf` in the desk board is not needed.

## Ideas beyond scope

A task title that is cut by `titleFor` in the service could carry the full text for an expand control. The sticky composer could use `interactive-widget=resizes-content` in the viewport meta on Chrome.

## Steps for Dom

None. Check the sticky composer and keyboard inset on a real phone when convenient.
