# RL.3 review: The rail replaces the sidebar, with Find

## Verdicts

- Round 1, `149ee8e1`: not clean, 2 must-fix. Find item values were the agent's name, so two agents with one name trapped keyboard navigation and Enter picked the wrong row. `passedOnBy` (rule 8) was never shown.
- Round 2, `b1855d61` (fix commit only): clean. Find values are now `<label> <path>`, and a hand-off reads "passed on by <agent>" on Needs you and Working rows. The fix commit also took the cheap nits: the rail shows Loading until the chosen scope answers, a one-member workspace forces Mine, `?item` counts only on `/desk`, Ctrl+K ignores Shift, Alt and key repeat and closes the phone sheet, the pulse stops under reduced motion, and the Working status shows on keyboard focus.

## What was built

- `components/rail/`: `Rail` (replaces `AppSidebar` inside the same `SidebarProvider`, 20rem wide), `useRail` and `useRailScope`, the pure `stableOrder` and `freshIds`, `dueLabel`, the Find registry and dialog, the Mine and Everyone toggle, setup rows, the Working list with its expander, the New panel, and `RailLink`.
- `_app.tsx` renders `Rail`. `AppSidebar`, `nav-registry.ts` and its test are deleted. The Needs you and open Q&A polls that only fed the old badges went with them.
- Rows link to `/desk?item=<id>` and `/desk?view=board` through `RailLink`, a plain-string link that calls `router.history.push`, because the typed `Link` rejects search params that `desk.tsx` does not declare yet. It keeps client-side navigation and normal modified clicks. Once RL.4 declares `item` and `view`, rows can move to the typed `Link`.
- Find (Ctrl or Cmd+K, the Find button, Everything) lists the Board, Every task, Log, Questions, Threads, Map, Schedules, Web triggers, Skills, Files and wiki, Things agents made, Computers, Agents, New agent, every agent by name, and every Settings page (derived from `settingsNav`). `find-registry.test.ts` compares the list with the files in `routes/_app/`. Excluded, each with its reason in the test: dynamic routes (`agents.$agentId`, `qa.$questionId`, `skills.$skillId`, `tasks.$runId`), the `/settings` layout and index, `/settings/managed-agents`, `/connectors` and `/machines` (redirects whose targets are listed).

## Checks

- `bun run check`, `bun run test` (web: 3481 pass, 1 skipped) and `bun run build` pass. The bundle grep for `drizzle` in `apps/web/dist/client` finds nothing.
- Browser, local dev, 1440x900 and 390x844 (touch): the rail rendered with three seeded agents, a failed run as a Needs you row, four running runs in Working, the setup step, Ctrl+K opened Find, typing an agent name and Enter opened it, Ctrl+K twice closed it, Everything opened it, the scope choice survived a reload, a Needs you row opened `/desk?item=<id>` without a page load and showed as current, and the phone sheet opened with every link and button at least 40px tall.
- `guest-execution.test.ts` crashed once in a full run (workerd closed a socket) while three dispatchers ran at once, and passed on its own straight after. It is not touched by this task.

## Choices where the spec was silent

- New is an inline panel under the header, not a popover. `NewTaskDialog` carries its own trigger and lives in `components/desk/`, which this task may not edit, so a popover would unmount the dialog as it opens.
- Setup rows link straight to `/settings/model-providers` and `/agents/new`, as the shell section says. RL.4's `?item=setup:...` pane is not linked from the rail.
- The Needs you count is the number of rows plus setup steps. The toggle shows the service's own counts.
- Rail data loads in the browser only (it needs the viewer's local midnight and the stored scope), so the server render shows an empty rail for a moment.
- A failed member lookup keeps the toggle, so Everyone stays reachable.

## Nits left

- Find's cmdk value includes the route path, so "agents" also matches every agent row, and short fragments match ids. A custom `filter` over label and hint would fix it. Two agents with the same name look identical in the list.
- Ctrl+K skips `preventDefault` on key repeat, so holding it reaches the browser's own shortcut.
- `usePolledQuery` does not drop an older response, so a Mine poll that lands after switching to Everyone leaves the rail on Loading until the next poll (up to 10 seconds). Toggle counts also vanish while that happens.
- `hover:bg-muted/50` replaces the open row's accent background while hovered.
- On a Working row, "passed on by" sits inside the truncated text and the title attribute holds only the status.
- The toggle buttons have no group label, and the New panel ignores Escape and outside clicks.
- `history.push` adds an entry when the row you are already on is clicked.
- No test covers the unique Find value or the passed-on-by text on a row.

## Ideas beyond the scope

- A controlled `open` prop on `NewTaskDialog`, so New can be a real menu.
- A badge on the phone menu button with the Needs you count, since the rail is closed on phones.
- `desk.needsYouCount` has no caller in the app now. The spec keeps it for other callers.

## Left to RL.4

- The spec's line "on phones `/desk` with no `item` shows the same list inline" sits in the RL.3 section, but it needs `desk.tsx`, which RL.3 may not touch. `Rail` keeps its body in one component tree, so RL.4 can lift the list out of `rail.tsx` if it wants to reuse it, or build its own from `useRail`.
- With no `?item`, RL.4's pane shows the first item, but the rail's `openId` is null, so that row is not highlighted and may move. RL.4 should put the shown item id into the URL (replace) so rule 10 holds.

## Steps for Dom

None. For a worktree dev server, `ARTIFACT_VIEW_KEY` has to be set in `apps/web/.env.local`, or `/desk` fails with "A private room ticket key is required". `.env.example` lists it, but the copied `.env.local` has no value.
