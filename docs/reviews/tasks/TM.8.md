# TM.8 review: Home, cards grouped by team

Dispatched with four Haiku workers on disjoint files: the grouping and collapse-storage logic (`roster-logic.ts`), the lead badge (`agent-card.tsx`), the group heading (`team-group.tsx`) and the member picker (`add-to-team-dialog.tsx`). The dispatcher wired them into `roster-wall.tsx` and `routes/_app/home.tsx` and wrote the wall tests. Reviewed by Opus. The browser proof is in `docs/reviews/tasks/TM.8/browser.md`.

## Rounds

- Round 1, at 227a7019: clean. Five nits.
- Browser round 1, at 4156116a: fail. A team named "Customer Success and Onboarding Operations Group" pushed the page sideways at 390px. Fixed in b29d73f8 (`max-w-full` on the heading block, and a 40px touch target for the toggle on coarse pointers).
- Browser round 2, at b29d73f8: pass. Flows A to E at 1280x800 and 390x844. The session log holds 400s right after each dev login redirect and 401s from a lapsed dev Clerk session. None came from a Home action.

## Decisions the task left open

- Home groups by the agent's home team (`card.teamId`). A team with no cards still gets a group, so its first member can be added from Home. Agents whose team is unknown or archived land under "No team".
- Group order is team name, then id. "No team" is last and left out when empty. Within a group cards keep the state order of the old wall, so a card that needs you stays first.
- While the workspace has no team the wall stays flat with no headings. In practice every workspace gets an "Everyone" team that cannot be archived, so Home always shows groups, with an empty "Everyone" group on a fresh workspace.
- The heading counts are agents and agents' requests waiting (`needsYouCount`). People in a team are not counted.
- "Open room" is a plain link to `/teams/<id>/room` through `RailLink`, because that route is built in TM.7 and is not in the typed route tree yet.
- The member picker is a small dialog inside `components/roster`. TM.6 builds the team page's picker in parallel, so the two are separate for now.
- Adding an agent that already has a home team makes it a non-home member. Its card does not move. The picker shows "In <team>" for those agents.
- Collapse state is read from local storage after mount (key `hm:roster-collapsed:<userId>`, a JSON array of team ids, "no-team" for the last group), so the server render and the first client render agree. Home loads the user id through `me`.

## Nits left

- `roster-wall.tsx`: every member sees "Add to team", but only the team owner or an org admin can add. Anyone else sees the Forbidden message in the picker after choosing.
- `add-to-team-dialog.tsx`: an agent with another home team is offered and added without any visible change on Home.
- `home.tsx`: `trpc.me` is read again on every poll.
- `roster-logic.ts`: the storage key uses the `hm:` prefix, like `hm:rail-scope`; other keys use `agentum:`.
- The picker's title and close button scroll away on a long list, and the Close button is 28px tall on a phone (shadcn `ui/` file, not edited).
- The "M need you" part of the heading was not seen in the browser. A component test covers it.

## Ideas beyond the scope

- Once TM.6 merges, use its member picker here and delete `add-to-team-dialog.tsx`.
- Hide "Add to team" for people who cannot change the team.
- Move an agent's home team from the picker ("Move here").

## Steps for Dom

None.
