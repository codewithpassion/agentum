# RH gate, round 1

Commit reviewed: a4597d37 ("tasks: RH.7 done"), diffed against `rh-start`. I read the RH merges one at a time (RH.1 b545b055, RH.2 306a6511, RH.3 81af5eda, RH.4 6750c9c9, RH.5 bd66e1f8, RH.6 e150c344, RH.7 cf543d05) and the current state of the files they touch. I checked them against the RH task files, the build plan's Decisions, Vocabulary and RH overview, Proposal A in `report.html`, CLAUDE.md in the checkout and "Rules that are easy to break" in HANDOVER.md. RH.8 to RH.11 and the walkthrough's "Nits left alone" are not repeated here.

`bun run check`, `bun run test` (4927 web tests plus the other packages) and `bun run build` pass on this commit. The client bundle contains no `drizzle`.

## Verdict

Not clean. Three findings are must-fix, and all three are small. The card wall, the room with seven tabs, the Right now panel, the top bar and the Needs you drawer match their scopes. The defects are at the edges. A card can call a blocked agent "Idle". Two signed-in entry points still land on `/desk`. One tab folder imports from another.

## Findings

| # | Severity | Finding | Area | Resolution |
|---|---|---|---|---|
| 1 | must-fix | A card reads "Idle" while its agent has a live run. `roster.list` asks the rail for the viewer's "mine" scope and counts only `running` as working. A member who is not the request's assignee, did not start the run and is not an escalated backup sees an agent blocked on a question as "Idle", sorted last. A `queued` or `offered` run reads "Idle" for everyone. The Right now panel in the same agent's room treats `waiting` and `queued` as the active task, so the card and the room disagree. RH.2 keys `needs_you` to the agent's owner or backup, not to the viewer. The service tests mock `rail.get` and never exercise the scope. | RH.2, `packages/services/src/roster.ts` | New task, scope below |
| 2 | must-fix | Two signed-in entry points still go to `/desk`. Accepting an invitation sends the new member to `/desk`, and the workspace picker's default target is `/desk`. RH.3 says the signed-in landing goes to home instead of `/desk`, and the Decisions table replaces "the desk is home". | RH.3, `routes/accept-invitation.tsx`, `integrations/clerk/picker-redirect.ts` | New task, scope below |
| 3 | must-fix | The Settings tab imports `canManageAgentKeys` from the Keys tab's folder (`room/settings/index.tsx` imports `../keys/keys-logic.ts`). RH.4 says no tab imports from another tab's folder, and build plan rule 6 depends on it for parallel lanes. KY.13 (a9ac2cd2) added the import, but it breaks the RH frame. | RH.4 frame, KY.13 | New task, scope below |
| 4 | nit | A renamed agent keeps its old avatar. The glyph is fixed from the name at creation, `agents.update` never touches `avatar`, and no control sets it. Rename "Lunch Planner" to "Standup Helper" and the card still shows "L". Once RH.8 puts the stored avatar in the room header, the stale letter shows there too. | RH.1, `packages/services/src/agents.ts` | Add to RH.8: refresh the default avatar on rename unless one was chosen by hand |
| 5 | nit | The card and the room header use different job-line rules. The card and the Jobs tab use `jobLineFor` (first sentence, 80 characters). The header uses its own `jobLine` (first line, 120 characters, cut at a word). One agent shows two different job lines. | RH.4, `room/header-logic.ts` | Use `jobLineFor` in the header, or one shared rule, and delete the second |
| 6 | nit | Home's Needs you chips read `useRail` directly. They skip the drawer's take-over filter (`actionableNeedsYou`) and its one-person rule that forces "mine", so the strip and the drawer count can disagree. The card states always use "mine", whatever the scope toggle says. | RH.3, `routes/_app/home.tsx` | Feed the chips from the same rule as `useNeedsYou` |
| 7 | nit | Home makes three rail computations every 10 seconds: its own `useRail` poll, the top bar's `useNeedsYou` poll and the `rail.get` call inside `roster.list`. | RH.3, RH.6 | Share one rail read between the top bar and home |
| 8 | nit | Made today reads files and artifacts with two requests per run of today, up to 20 runs. It does this on every run status change and every 15 seconds while a run is live, beside the 3-second task poll. | RH.5, `room/now/use-now.ts` | One server read for today's files and artifacts, if the load shows up |
| 9 | nit | The top bar's "Files" link opens a page headed "Library", and its Find entry also says "Library" (NV.1 set that heading). The room's Files tab heads its section "Library" too. A person clicks one word and lands on another. | RH.6, RH.4 | Pick one word for the page, its Find label and the top bar link |
| 10 | nit | At 72rem and wider, the Chat tab puts the conversation list in the right column under Right now. RH.4 says the list sits on the left, as in the mockup. The RH.5 layout commits made this choice and their review passed it, so this needs a decision, not necessarily a fix. | RH.4, RH.5, `room/chat/index.tsx` | Confirm with Dom or move the list left |
| 11 | nit | A paused agent shows "stopped" ahead of `needs_you`, which reverses RH.2's precedence. SP.3 (9ebdd4bf) did it on purpose, because the pause is itself a request to the owner. The walkthrough never exercised a pause. | SP.3 in `roster.ts` | Note the rule in RH.2's task file, or show it as `needs_you` with the pause line |
| 12 | nit | The Right now panel imports `LearnedList`, `learnedThisWeek` and `useMemory` from the Knows tab's folder. `now/` is a panel, not a tab, and the RH.5 log records the choice, but it couples the panel to the Knows lane. | RH.5, `room/now/learned-slot.tsx` | Leave it, or move the shared pieces out of `knows/` when either side changes |
| 13 | nit | The comment above `ChatTab` says the columns follow "the space beside the rail". The rail is gone. | RH.4, `room/chat/index.tsx` | Reword the comment |
| 14 | nit | The connector OAuth return still builds `/agents/<id>?sheet=tools`, in `connector-oauth.ts` and `routes/connectors-oauth.ts`. The legacy redirect makes it work, at the cost of one extra hop. | RH.4 | Write `?tab=keys` directly |

## Must-fix 1: a live run never reads "Idle" on a card

Scope.

- In `packages/services/src/roster.ts`, decide first what keys `needs_you`. The task file says an open request that names the agent's owner or backup. The code says a request in the viewer's own Needs you list. Record the choice in RH.2's log.
- If it follows the task file, ask the rail for every item the viewer may see (the "everyone" scope, which keeps the private-session rules) and take the wait for each agent from that.
- Whatever the choice, a `waiting` run that has no visible wait shows as `needs_you` with a plain line such as "Waiting on Ann". A `queued` or `offered` run shows as `working` with a line such as "Queued" or "Starting". Neither reads "Idle".

Check.

- A service test builds the real rail service, not the mock, with two members. Agent owned by A, a question open on its run, B lists the roster: B's card is not "Idle", and its state follows the recorded choice.
- Service tests: a `queued` run and an `offered` run each give `working`.
- The existing precedence tests still pass.
- `bun run check && bun run test && bun run build` pass.

## Must-fix 2: every signed-in entry lands on home

Scope.

- `apps/web/src/integrations/clerk/picker-redirect.ts`: the default target becomes `/home`, and the doc comment changes to match.
- `apps/web/src/routes/accept-invitation.tsx`: both `/desk` assignments become `/home`. Rename `GoToDesk`.
- Leave the `/assistant` redirect alone, because it opens the assistant panel on top of `/desk` on purpose. Grep `routes/` and `integrations/` for any other `"/desk"` landing.

Check.

- The picker-redirect test expects `/home` when no redirect is given.
- Browser: choose a workspace with no redirect and land on `/home`. Accept an invitation with a second dev user and land on `/home`.
- `bun run check && bun run test && bun run build` pass.

## Must-fix 3: no tab imports from another tab's folder

Scope.

- Move `canManageAgentKeys`, with its test, out of `components/agent/room/keys/keys-logic.ts` into a file under `components/agent/` outside the tab folders, for example `components/agent/agent-rights.ts`. Import it from there in both the Keys and Settings tabs.
- Add a test that no file under `components/agent/room/<tab>/` imports from another tab's folder. `now/` may import from `knows/`, as the RH.5 log allows.

Check.

- The new import test fails on this commit and passes after the move.
- `bun run check && bun run test && bun run build` pass.

## What I checked and found sound

- The migration adds `agents.avatar` and backfills it in SQL with the same rule as `defaultAgentAvatar`. Its snapshot and journal are committed. The roster service checks access with `authorize()` first, and 50 agents take a bounded number of queries. The router is one service call, and `compose.ts` wires the service.
- The card wall sorts `needs_you`, `stopped`, `working`, `idle`, then by name. It refreshes on the rail's 10-second interval, the chips open `/desk?item=`, the two dashed cards link to `/agents/new`, and Home is in Find.
- The room has a header and seven tabs driven by `?tab=`, with tab and tabpanel roles and arrow-key focus. Old `?sheet=` and `?mail=` links redirect to the right tab. `profile-rows.tsx`, `manage-sheet.tsx` and `sheet-ids.ts` are gone, and the tab and shell folders hold no orphaned files.
- The Right now panel shows the step line from the receipt, Watch and Take over, Made today, helpers with Stop and a link, and Learned this week. It renders nothing for an archived agent.
- The top bar matches RH.6 and CLAUDE.md. `useNeedsYou` runs in `AppTopBar`, so the count and Ctrl+K stay live with the drawer closed. Nothing calls `useSidebar`, and on a phone the bar collapses to Home, Needs you and Menu. CLAUDE.md's section describes the drawer.

## Verdict

Not clean. Three must-fix findings: a live run reads "Idle" on a card, two signed-in entry points still land on `/desk`, and the Settings tab imports from the Keys tab's folder. Eleven nits.
