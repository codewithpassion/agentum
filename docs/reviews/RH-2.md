# RH gate, round 2

Commit reviewed: cbb8294b ("tasks: RH.14 done"), diffed against `rh-start`. Round 1 (`docs/reviews/RH-1.md`) reviewed a4597d37. Since then the three must-fix tasks merged: RH.12 (66a4e9f9), RH.13 (d432071f) and RH.14 (2f5f8e9a). I read each merge, its task file, its review record and the current state of the files it touches. I also read what other merges changed in RH files since a4597d37 (TM.8's team groups on home, KY.15 in the Keys and Settings tabs, NV.2's plain choices in Settings, DR.8's held dreams in the rail and the Knows tab, the teams prop on the top bar's Find). I checked all of it against the RH section of the build plan, the RH task files, CLAUDE.md in the checkout and "Rules that are easy to break" in HANDOVER.md. RH.8 to RH.11 and the round-1 nits are not repeated.

`bun run check`, `bun run test` (5184 web tests pass, 1 skipped, plus 402 in the other packages) and `bun run build` pass on cbb8294b. The client bundle contains no `drizzle`.

## Verdict

Clean. All three round-1 must-fixes are resolved, and I found nothing new that is must-fix. The other merges since round 1 do not break RH. Six nits follow.

## Round-1 must-fixes

1. A live run never reads "Idle" on a card (RH.12): resolved. `roster.list` asks the rail for the "everyone" scope, so `needs_you` is the same on every member's card, and the rail's private-session rules still apply. A `waiting` run with no visible wait reads `needs_you` with "Waiting on <owner>" or "Waiting on a person". A `queued` run reads `working` "Queued", and an `offered` run reads `working` "Starting". The run query now loads every live run, not only the latest and `running` ones, and it still keeps to the sessions the viewer may see, so another member's private waiting run stays hidden. The decision is recorded in RH.12's task file and in RH.2's log. `rail.test.ts` builds the real rail with two members and shows that the member the request does not name sees the same `needs_you` card as the owner. `roster.test.ts` covers queued, offered, running before queued and an older waiting run behind newer finished ones.
2. Every signed-in entry lands on home (RH.13): resolved. The picker's default target, both assignments in `/accept-invitation`, the invitation step kind (now `home`) and `useSwitchWorkspace`'s default all go to `/home`. Round 1 of RH.13's own review caught `useSwitchWorkspace`. That hook serves the top-bar workspace menu and the landing page's no-access list. CLAUDE.md's two sentences changed to match. `/` redirects to `/home`, and Clerk's fallbacks go to `/`. The only `"/desk"` redirect left is `/assistant`, which the task keeps on purpose. Every other `/desk` reference is a link to the desk or a Needs you item, not a landing.
3. No tab imports from another tab's folder (RH.14): resolved. `canManageAgentKeys` and its tests moved to `components/agent/agent-rights.ts`, and Keys and Settings import it from there. `room/tab-imports.test.ts` scans every file under `room/<folder>/`, including bare folder imports, and fails on any cross-folder import outside `chat>now`, `work>now` and `now>knows`. It also asserts that it finds exactly those three edges, so a scan that parses nothing cannot pass. The two edges the task did not name (`chat>now`, `work>now`) are the Right now panel that those tabs host, which matches round 1's finding 12. It passes on cbb8294b, including after KY.15, NV.2 and DR.8 changed the Keys, Settings and Knows tabs.

## Findings

| # | Severity | Finding | Area | Resolution |
|---|---|---|---|---|
| 1 | nit | "Waiting on <name>" always names the agent's owner. After escalation to the backup, or when the run's own starter was asked, the line names the wrong person. The fallback shows only when the rail lists no item for the run, so the case is rare. RH.12's review left it. | RH.12, `packages/services/src/roster.ts` | Name the person the open request is for, or say "Waiting on a person" when the roster can't tell |
| 2 | nit | Team headers on home say "N need you" from the sum of the cards' `needsYouCount`. Since RH.12 that count covers every member's items, so a member sees "2 need you" on a team where nothing is theirs to answer, while the Needs you chips and drawer show none. TM.8 wrote the header, and RH.12 changed what it counts. | RH.12 with TM.8, `components/roster/team-group.tsx` | Word the header for the agents ("2 waiting on a person") or count from the viewer's own Needs you items |
| 3 | nit | A waiting run now ranks ahead of a newer failed or interrupted run. An agent whose latest run failed while an older run waits shows `needs_you`, not `stopped`. That is a defensible order, but no test pins it and RH.2's precedence text does not mention it. | RH.12, `roster.ts` `activityFor` | Add a test for the order chosen, and a line in RH.2's log |
| 4 | nit | The comment above `STARTING_STATUSES` ("Which map a live run goes in: one per kind of live state") describes `runFacts`, not the constant. | RH.12, `roster.ts` | Move the comment to `runFacts` or reword it |
| 5 | nit | `canManageAgentKeys` in `agent-rights.ts` now also gates the owner and backup selects in Settings, but its name and doc comment still describe Keys only. | RH.14, `components/agent/agent-rights.ts` | Rename it (for example `canManageAgent`) and widen the comment when the file is next touched |
| 6 | nit | RH.13's check asked for a real invitation accepted by a second dev user, and the browser proof did not run one. It ran the member and no-org paths of `/accept-invitation`, which end on the same changed line, and skipped `invitation.accept()`. RH.13 did not change that call. Nothing unit-tests `useSwitchWorkspace`'s `/home` default either. The browser run covers it. | RH.13 | Dom tries the real Join path once on staging, as RH.13's review suggests. No code change |

The round-1 nits not folded into RH.8 to RH.11 are still open (for example the stale "beside the rail" comment in `room/chat/index.tsx`, the `?sheet=tools` OAuth return and the two job-line rules). They were not in scope for this round.

## Must-fix scopes

None.

## What I checked and found sound

- RH.12 keeps the layering: the router is one call, the service uses `authorize()` first, and the rail is reused for owner fallback, backup escalation and private sessions instead of copied.
- The run query still filters to visible sessions and to `dry_run = false`, so the wider live-run set leaks nothing.
- DR.8's held-dream cards reach the rail through `desk.railSources` and `optionalCardFields`, so they count as a wait on the card like any other Needs you item, as CLAUDE.md asks.
- TM.8's team groups and add-to-team dialog on home, and the `teams` prop on the top bar's Find, leave the card states, the sort and the 10-second refresh as RH.3 and RH.6 set them. `useNeedsYou` still runs in `AppTopBar`.
- No shadcn file was hand-edited, no new `@repo/db/schema` import reached the app, and no `createServerFn` appeared.

## Verdict

Clean. No must-fix findings. The three round-1 must-fixes are resolved, and six nits are listed above.
