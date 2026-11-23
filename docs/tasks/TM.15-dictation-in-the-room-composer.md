---
id: TM.15
title: "Dictation in the room composer"
milestone: TM
size: S
status: done
depends_on: [TM.13]
branch: null
lane: web-room
executor: claude
---

From the teams walkthrough (`docs/reviews/TM-e2e.md`).

Finding (from TM.9's log). The old inbox composer (`components/inbox/post-composer.tsx`, removed in TM.9) had dictation. The room's `mention-composer.tsx` has none, and every other prompt box does (DT.2).

Scope. Add `DictationButton` and `DictationPreview` to the room composer, as `composer-container.tsx` does. Decision: yes, it should.

Check. A test that the button shows, and the browser at both sizes.

## Log
- 2026-11-21: added by controller.
- 2026-11-21: deferred to the backlog on Dom's scope freeze (only must-fix bugs stay in v4).
- 2026-11-22: back in scope on Dom's call (all deferred tasks except the flaky-test fixes).
- 2026-11-22: dispatched.
- 2026-11-22: merged at c0333858, review clean after 0 fix rounds. Browser check moved to the end pass.
