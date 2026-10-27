# MB.4 review

Screenshots are in `docs/reviews/tasks/MB.4/` (390x844, 360x740, 1280x800), taken on the local dev server with seeded data: one waiting run with a question and a tool approval, eight done runs, and a 30-post inbox thread.

## Findings

- F-13: the task composer is sticky at the bottom below md (`StickyComposer`, bottom offset follows `visualViewport` so the on-screen keyboard does not cover it). Buttons are 40px through the MB.1 coarse-pointer rule, the textarea is 16px through the MB.1 rule. The hint reads "Tap Send to send" on `(hover: none) and (pointer: coarse)` devices. Enter behaviour is unchanged.
- F-15: below md the inbox shows the thread list or the open thread, with a "All threads" back link. The thread scrolls to its latest post once on load, and the composer is sticky.
- F-12: receipt bodies get "Show more" below md. Fact chips sit in a two-column grid below md (two rows). The "Desk" breadcrumb and "Stop task" are 40px on coarse pointers. The task title is not expandable: the service cuts it with an ellipsis (`titleFor`), the full text is in receipt step 1, which now expands.
- F-03: desk card titles take two lines below md (the same service cut applies). The Done lane shows five cards below md, then "Show N more". Filter chips and Approve / See changes / Reject are 40px on coarse pointers with wider gaps.
- Request cards: checked at 390x844 in the desk and in the task receipt and thread with a seeded choice question and an approval. They fit, buttons wrap, no sideways scroll at 360 or 390. No change needed.

## Verdicts

Round 1: pending.

## Notes

The agent-browser viewport does not report a coarse pointer, so the 40px targets were checked from the CSS rules, not measured.
