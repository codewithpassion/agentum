# RH.4 review: agent room, one page with seven tabs

## Verdicts

- Round 1 (7e93f2a5): not clean, 2 must-fix. The tab bar sat inside the archived fieldset, so an archived agent's tabs could not switch. The Chat thread kept its state when the agent changed.
- Round 2 (3f2d9222, fixes only): not clean, 1 must-fix. The first fix was right. The `key` on the Chat thread was missing: the python edit that added it hit text Ultracite had already reformatted and did nothing, and the commit message said otherwise.
- Round 3 (70ddef9f, fixes only): clean. Both bugs now have tests written first: `room/room-frame.test.tsx` (the bar is outside the disabled fieldset) and `room/chat/switch-agent.test.tsx` (Chat drops agent A's thread when the agent changes).

## Browser check

See `docs/reviews/tasks/RH.4/browser.md` for the walk at 1280x800 and 390x844.

## Decisions to know

- Tabs import the existing components from `components/agent/profile/`, not from each other. Shared pieces live next to the tabs: `room-data.ts` (`RoomData`, `RoomTabProps`), `section.tsx`, `room-frame.tsx`.
- `?sheet=` and `?mail=` are not redirected. `resolveTab` maps them, and clicking a tab drops them. `?tab=` wins when both are present.
- Chat calls `sessions.main` on mount, so opening an agent makes the caller's main conversation if it does not exist yet. An archived agent skips the call.
- `TaskPage` got `embedded` and `onSent`, `TaskThread` and `EmptyThread` got `onSent`: a send in the room re-reads the thread in place instead of navigating to `/threads/<id>`.
- The map inspector's editor lost the profile rows and sheets, because `profile-rows.tsx`, `manage-sheet.tsx` and `sheet-ids.ts` had to go. It now links to the Knows, Keys, Jobs and Settings tabs and to the room. Its mailbox read and reload plumbing went with it.
- The old Owner row (owner and backup selects) moved to Settings. The header shows the owner's name read-only.
- `profile-header.tsx` was deleted too: `room-header.tsx` replaces it.

## Environment notes

- Root `bun run test` can fail on `desktop::apps::tests::the_session_bus_listens_where_the_environment_says` (Rust) when the worktree path is too long for a D-Bus socket.
- `apps/web/src/server/live-artifacts/guest-execution.test.ts` fails in this worktree (miniflare socket closes, "Not allowed: runs.guest_access" in its log) and passes in the main checkout. Nothing in RH.4 touches live artifacts. Every other web test passes (4411) and the script tests pass (401).

## Nits left

- Chat: the conversation list (`ThreadsCard`) is not refreshed after a send, and its rows open `/threads/<id>`, which leaves the room.
- `use-task-computer.ts:69` reads the room's `?tab=` on popstate while embedded.
- The Chat thread adds a second `h1` (`thread-title.tsx`, `empty-thread.tsx`) under the room's `h1`.
- `tab-bar.tsx`: `dataset.tab as RoomTab` is a type assertion.
- The tab panel has no `tabIndex` (Biome's noNoninteractiveTabindex rejects 0 on a tabpanel), and `aria-controls` points at the single rendered panel only.
- A long job line can truncate the owner in the header (`room-header.tsx`).
- `?sheet=edit` opens Settings but does not scroll to the form. The Settings tab of an archived agent still renders every panel (disabled).
- `WorksWith` keeps the old `Row` layout in Keys.
- `receivesFromText` is no longer shown anywhere.
- The chat test does not cover the `onSent` path.
- `agentId` in the `MainThread` effect dependencies is redundant now that the component is keyed by agent.

## Dead code left

`chip-list.tsx` (`ChipList`) and the chip builders in `profile-logic.ts` (`browserChip`, `channelChips`, `handsToChips`, `receivesFromText`, `skillChips`, `startChips`, `toolChips`) have no caller now. Their tests still pass. JB, KY and ME may reuse them, so they stay until one of them says otherwise.

## Beyond scope

- A real DOM test library setup (happy-dom is used ad hoc in a few tests) so tab interaction can be tested end to end.
- A "last seen" count on the Chat tab and a badge on tabs that need a decision (Keys approvals, Jobs failures).

## For Dom

Nothing needs your accounts or dashboards.
