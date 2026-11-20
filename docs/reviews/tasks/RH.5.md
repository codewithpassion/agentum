# RH.5 review: Agent room, the Right now panel

## Verdicts

- Round 1 (744d230): must-fix. A helper run was picked as the running task, because `tasks.list` returns helper runs under the parent's agent id. The three-column Chat layout at `lg` left the thread about 80 px wide beside the rail.
- Round 2 (7eb0653, fix commits only): clean. `TaskListItem` now carries `helper` (`subagentLevel > 0`) and `activeRun` skips helpers. Columns moved to a container query. The same round fixed per-helper busy state, a visible poll error, an ordering guard on Made today reads, and one Take over button while the screen is open.
- Browser proof, three rounds, the last one PASS (`docs/reviews/tasks/RH.5/browser.md`, head 34d01f5):
  - Round 1 failed on the Chat thread width at 1280 with the rail open, and on a queued task replacing the running one. Fixed in 4ae575b (container queries, running or waiting task wins over queued).
  - Round 2 failed on the thread width at 1280 collapsed and at 1600 and 1920, where a third column squeezed a long thread title. Fixed in 34d01f5: from 72rem the thread keeps the left column and the panel and the conversation list stack in a 20rem right column.
  - Round 3 passed every flow at 1280, 1600, 1920 and 390 wide.
- The last two commits (4ae575b, 34d01f5) are layout and selection fixes that no code reviewer has read. The browser verifier measured them, and `bun run check`, the room tests and the full suite pass on the merged head.

## Nits left

- `todaysRuns` does not skip helper runs, so they count against the 20-run Made today cap and add reads per 15 s poll.
- Made today de-duplicates files by path, which never repeats across runs. Harmless.
- `useMadeToday` calls `Date.now()` during render so a tab left open past midnight moves on. The 3 s poll re-renders the panel, so it works.
- `now-logic.test.ts` uses a type assertion where a second fixture variable would do.
- `live-panel.test.tsx` and `helpers-card.test.tsx` each carry their own happy-dom setup.
- The panel polls `tasks.list` (50 rows) and `tasks.get` every 3 s while the tab is visible, and reads files and artifacts of up to 20 runs every 15 s while a task runs. A session stream would be lighter.
- The Learned slot reads the whole memory payload on each Chat or Work mount.
- Learned this week imports from `knows/`, which breaks "a tab imports nothing from another tab's folder". ME.6 asked for it in the task log.

## Ideas beyond the scope

- The map inspector and the Work tab's recent tasks still list helper runs as tasks of their own. The new `helper` flag lets them hide those.
- A server read for "made today" (one call per agent) would replace the per-run `tasks.files` and `artifacts.list` calls.
- A takeover that starts without the agent asking is not possible through the `takeover` procedures, which all need a request id. The Take over button waits for the agent's request.

## For Dom

- Take over was only seen failing with the expected 409 (no desktop). Watch and a successful take need a real machine with a desktop: open an agent with a computer while a task runs and press Watch, then Take over when it asks.
