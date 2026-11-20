# RH.4 review: agent room, one page with seven tabs

## Verdicts

- Round 1 (7e93f2a5): not clean, 2 must-fix. The tab bar sat inside the archived fieldset, so an archived agent's tabs could not switch. The Chat thread kept its state when the agent changed.
- Round 2 (3f2d9222, fixes only): not clean, 1 must-fix. The `key` on the Chat thread was missing: a scripted edit hit text Ultracite had already reformatted and did nothing, and the commit message said otherwise.
- Round 3 (70ddef9f, fixes only): clean. Both bugs have tests written first (`room/room-frame.test.tsx`, `room/chat/switch-agent.test.tsx`).
- Round 4 (dff21ef0): not clean, 2 must-fix. A disabled fieldset does not stop links (the "Connect as me" links) or Radix selects that portal outside it (Owner and Backup). An archived agent's Keys, Knows, Jobs and Settings tabs now show a note instead of the panels that change the agent, as the old page did by not rendering the manage sheets.
- Round 5 (79b7e995): clean on product code. The earlier browser walk (1dd87746 and 8b598bef) is in `docs/reviews/tasks/RH.4/browser.md`.
- Round 6 (8b598bef): not clean, 1 must-fix in a test: the disabled-state check counted links as disabled. Form controls and links are now tested apart, with an allowlist of read-only hrefs for links.
- Round 7 (1c06020c, fixes only): clean. Its test nits were taken: the read-only link allowlist is one exact href with a non-empty guard, and `desk/mail-strip.test.tsx` checks the mail link carries `tab=keys` and `mail=1`.

## Browser check

`docs/reviews/tasks/RH.4/browser.md`: F1, F2, F3, F6 and F7 walked at 79b7e995, F4 and F5 re-walked at 8b598bef, all at 1280x800 and 390x844. Verdict pass. Two defects from the first walks were real and are fixed: the "New conversation" button ran past its card, and Work did not list a task after a Chat send until a reload. A third, "archived controls stay live", was a misreading: the verifier read the `.disabled` property, which stays false inside a disabled fieldset. It did point at the real gaps (links and portalled selects), fixed in round 4.

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
- `apps/web/src/server/live-artifacts/guest-execution.test.ts` (workerd through miniflare) fails in this worktree most runs ("other side closed" on a socket) and passed in the main checkout. Nothing in RH.4 touches live artifacts. Every other web test passes and the script tests pass (401). Treat it as environment, and run it in the main checkout at the merge check.

## Nits left

- Chat: the conversation list rows open `/threads/<id>`, which leaves the room.
- `use-task-computer.ts:69` reads the room's `?tab=` on popstate while embedded.
- The Chat thread adds a second `h1` (`thread-title.tsx`, `empty-thread.tsx`) under the room's `h1`.
- `tab-bar.tsx`: `dataset.tab as RoomTab` is a type assertion.
- The tab panel has no `tabIndex` (Biome's noNoninteractiveTabindex rejects 0 on a tabpanel), and `aria-controls` points at the single rendered panel only.
- A long job line can truncate the owner in the header (`room-header.tsx`).
- `?sheet=edit` opens Settings but does not scroll to the form. The redirect to `?tab=` drops query params other than `tab` and `mail`, and the hash.
- The address bar reads `?mail=1&tab=keys` (params sorted by the router), not `?tab=keys&mail=1`.
- `WorksWith` keeps the old `Row` layout in Keys. `receivesFromText` is no longer shown anywhere.
- The chat test does not cover the `onSent` path.
- `agentId` in the `MainThread` effect dependencies is redundant now that the component is keyed by agent.
- `task-thread.tsx` keeps `?tab=mail` as the routing link of a mail-started thread: it is the thread page's own Mail tab, not a room tab.
- The map inspector shows a "Profile" link next to "Open agent room" (it was there before this task).
- An archived agent's Chat, Work and Settings tabs still link to read-only pages (`/sessions`, `/tasks/...`, `/settings`...). The test pins that list.

## Dead code left

`chip-list.tsx` (`ChipList`) and the chip builders in `profile-logic.ts` (`browserChip`, `channelChips`, `handsToChips`, `receivesFromText`, `skillChips`, `startChips`, `toolChips`) have no caller now. Their tests still pass. JB, KY and ME may reuse them, so they stay until one of them says otherwise.

## Beyond scope

- A real DOM test library setup (happy-dom is used ad hoc in a few tests) so tab interaction can be tested end to end.
- A "last seen" count on the Chat tab and a badge on tabs that need a decision (Keys approvals, Jobs failures).

## For Dom

Nothing needs your accounts or dashboards.
