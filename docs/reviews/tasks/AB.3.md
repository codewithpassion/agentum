# AB.3 review

The Always badge in ask overrides no longer wraps. The row moved into `OutsideEmailRow` in `ask-before-card.tsx`, and the badge has `shrink-0 whitespace-nowrap` at every width. Before, both classes applied only below `md`.

## Verdicts

Round 0, commit 2d097281: not clean. One must-fix, `apps/agentum/pid` (a runtime file the tests write) was committed. Nit: the test file name did not match its source.

Round 1, commit fae3208e: clean. Both items fixed.

## Nits left

`apps/agentum/pid` is untracked and not in `.gitignore`, so a `git add -A` can pick it up again. It is outside AB.3.

The test checks class names in static markup, not rendered layout.

## Not verified

No browser screenshot at a narrow and a wide width. The component test stands in for it. The staging check is the controller's.

## Steps for Dom

None.
