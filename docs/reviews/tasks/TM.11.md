# TM.11 review: Home hides empty team groups; one member picker

Dispatched with three Haiku workers on disjoint files: the group logic (`roster-logic.ts`), the shared picker (`components/team/add-member-form.tsx` and `add-agent-dialog.tsx`) and the team page's Room link (`room-link.tsx`). The dispatcher wired the roster wall to the shared picker, deleted `components/roster/add-to-team-dialog.tsx` and updated the wall tests. Reviewed by Opus. The browser proof is in `docs/reviews/tasks/TM.11/browser.md`.

## Rounds

- Round 1, at 6edca1ff: must-fix. Agents do not join a team when they are created, so on a fresh workspace every card has no home team and Home showed a lone "No team" heading. The flat wall was still out of reach. Fixed in 05781aa0: the wall is flat when every group is the Everyone team or "No team".
- Round 2, at 05781aa0 (fix commit only): clean. Two nits.
- Browser, at 42c8ec6a (after `git merge main`, which brought in TM.7 and RH.12): pass. Flows A to E at 1280x800 and 390x844, no console errors and no failed requests beyond one 401 right after the dev-login redirect and one 400 the verifier provoked on purpose to see the picker's error line.

## Decisions the task left open

- "Everyone" is the team whose `slug` is `EVERYONE_TEAM_SLUG`.
- The flat rule is "every group is Everyone or No team", not only "Everyone is the only team with agents", because a fresh workspace has agents in no team and Everyone has no member rows. The task file still words it as Everyone only.
- A team with no agents gets no group on Home. Its first member is added from the team page.
- One picker: the team page's `AddMemberForm` (a labelled native select and an Add button). Home's "Add to team" opens `AddAgentDialog`, a dialog around it in `components/team`. Home passes its agent cards as the candidates through `addableAgents`.
- The "Open room" link on the team page uses `RailLink` with a plain path, like Home's group heading, so it does not depend on the typed route tree.

## Nits left

- `add-agent-dialog.tsx`: the select shows the agent name only. The old picker also showed the job line and "In <team>". Two agents with the same name look the same.
- `add-agent-dialog.tsx`: `AddAgentForm` repeats `member-list.tsx`'s stale-choice and submit logic, so only the select form is shared between the two pickers.
- `add-agent-dialog.tsx`: `AddAgentForm` is exported only for its test.
- `roster-logic.ts`: when the wall is flat, Home has no "Add to team" card for Everyone, so agents in no team cannot be added to Everyone from Home. Same gap for a team with no agents.
- The "No team" group has no "Add to team" card (it has no team).

## Ideas beyond the scope

- Give agents a home team (Everyone) when they are created, so a fresh workspace's agents are in Everyone and the flat wall rule can go back to Everyone only.
- Show the job line in the picker's options, or move to a combobox.
- Use the typed `Link` for the Room links now that `/teams/$teamId/room` is in the route tree.

## Steps for Dom

None.
