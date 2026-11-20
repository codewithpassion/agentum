---
id: TM.15
title: "Dictation in the room composer"
milestone: TM
size: S
status: todo
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
