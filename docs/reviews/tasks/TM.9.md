# TM.9 review: Inbox becomes rooms in the shell

## Verdicts

- Round 1 (b872c7b3): clean. No must-fix findings. Check, test and build pass.
- Browser proof, first run (b872c7b3): pass at both sizes, but `/inbox?thread=does-not-exist` landed in the Everyone room with the made-up topic open, and that panel polled `inbox.readThread` and logged a 404 every few seconds. Treated as a fail of the "no console errors" rule. Fixed in 92908ed7: the redirect drops `topic` when the thread cannot be read.
- Browser proof, second run (92908ed7): pass at 1280x800 and 390x844, with one 404 console line left on in-app navigation to an unreadable id, from the redirect's own `readThread` probe.
- Round 2, on 92908ed7 and 1c7b8dc1 (fresh reviewer, asked by the controller): clean, no must-fix. 1c7b8dc1 adds `inbox.topicTeam`, which answers null for a missing or hidden topic where `readThread` answers 404, and the redirect uses it, so the 404 is gone.
- Browser proof, third run (1c7b8dc1): pass at 1280x800 and 390x844 for the unreadable id (in-app and full load), a topic in Everyone, a topic in a second team, and plain `/inbox`. No console errors, every request 200. Report and screenshots: `docs/reviews/tasks/TM.9/browser.md`, Round 3 section.

## Decisions

- `inbox.topicTeam` (service method and tRPC query) exists so the redirect can ask for a topic's team without a 404 for an unreadable id. It hides a limited topic the same way `readThread` does.
- Needs you and desk cards keep linking to `/inbox?thread=<id>`. The redirect finds the topic's team, so the cards carry no team id and no service type changed.
- Find keeps the team page entries and adds one "<team> room" entry per team. The Inbox entry and its "Threads" hint are gone, and `/inbox` is in the find-registry exclusions as a redirect.
- `inbox-logic.ts` and `use-polled-query.ts` stay in `components/inbox` because many files import them. `authorLabel` lost its only caller and went with its tests.

## Nits left

- Cards link through the redirect, so each click costs a thread read and a team list read before the room loads (`needs-you-card.tsx:100`, `desk-card.tsx:68`, `problem-pane.tsx:50`).
- The "<team> room" Find entries share the Users icon with the team page entries (`find-dialog.tsx`).
- The `topicTeam` service test lacks a limited topic the reader is not in, a topic with a null team and a read-only key, and `inbox-router.test.ts` has no `topicTeam` case (`inbox.test.ts:380`).
- A FORBIDDEN or network error from `topicTeam` now reaches the route's error boundary, where the old probe sent every error but UNAUTHORIZED to Everyone (`inbox.tsx:16`).

## Ideas beyond the scope

- The room composer (`MentionComposer`) has no dictation, which the old inbox composer had. The "inbox message" case left `dictation-rollout.test.tsx` with it. Adding dictation to the room composer would bring the case back.
- A card could carry `teamId` from `desk.railSources`, so the links go straight to the room and skip the redirect.
- A topic panel whose thread returns 404 polls forever (`room-thread.tsx`). Stopping the poll on NOT_FOUND would quiet a dead link left open.

## Steps for Dom

None.
