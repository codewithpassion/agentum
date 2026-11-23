# HM.3 review: Learned this week stays short

Verdict, round 1 (commit 750c46a): clean, no must-fix findings, 0 fix rounds.

## Nits left

- Work tab caps the Right now panel at the viewport below the app header, but the room header and tab bar sit above it, so a very long panel can still add their height to the page. Chat caps at max(24rem, 70vh), the conversation box height.
- The clamped text span also holds the "when" text, so a long sentence can hide the timestamp. The title carries only the sentence.
- Show all / Show less renders below the owner-only footnote when that footnote shows.
- `expanded` stays true after Undo drops the list to 3 or fewer, so it reopens expanded if the list grows again.
- chat/index.tsx: `order-first @6xl:order-none` and the `@6xl:row-span-2` on both items are now redundant. At 6xl the side column precedes the conversation in DOM and tab order.
- The `chat-side-column` test id has no test yet. The Undo test never covers a row shown only after Show all. The test file is named learned-card.test.tsx but imports from learned-slot.tsx.

## Beyond scope

- The Chat tab's conversation box is still a fixed 70vh; making it fill the window below the room header would need a sticky or fixed-height frame.

## Skipped browser steps

The task's browser pass (a task page for an agent with many learned items at 1440x900 and 390x844) was skipped and is left to the single pass after all tasks merge. Things to check there: the conversation box keeps its height, the side column scrolls on its own at 1440 wide, and the phone layout stacks as before.

## Steps for Dom

None.
