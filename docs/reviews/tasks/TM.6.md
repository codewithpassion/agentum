# TM.6 review: Team page

## Verdicts

- Round 1 (9e01125e): must-fix. The rules editor kept the previous team's text when the route params changed, so Save could write team A's rules into team B. Fixed by keying `TeamPage` by team id.
- Round 2 (a97682ce, fix commit only): clean.
- Browser proof (fresh verifier, a97682ce): PASS at 1280x800 and 390x844, see `docs/reviews/tasks/TM.6/browser.md`. It found a race on the Settings tab: two picks within a second lost the first, because the second built its config from stale props. Fixed in 96f3b67f and checked again, see the last section of `browser.md`.

## Decisions to know

- A static `/teams` page (list and New team button) was added next to `/teams/$teamId`. Find's registry test rejects dynamic paths, so `/teams/$teamId` is in `EXCLUDED` and Find lists each team through `teamFindEntries`. The `_app` loader now returns `{ agents, teams }`.
- Capability writes the model alias (opus, sonnet, haiku) to `agents.model`. Thinking level and context size merge into the full `runtimeConfig`, because `agents.update` replaces it. A model outside the three tiers shows as "Custom (...)" and is kept. Unset stays unset (no default is written).
- The Edit agent form on the Settings tab is keyed by agent id and model, so a stale model in it cannot revert the Capability choice. Changing Capability while the form holds unsaved edits resets those edits.
- The handle rules in `team-logic.ts` restate the service's, which the browser cannot import. A test checks the two agree.
- Standing jobs show the enabled jobs of member agents from `jobs.list`; the section is hidden when that read fails.

## Nits left

- An archived team hides every edit control, including Remove, which the service still allows. The note then wrongly says only an owner can change the team.
- A failed `teams.profiles.get` shows empty profile fields, and saving would overwrite the stored profile.
- The partial-failure toast after creating a team names only the first failure.
- A team name that cannot form a slug fails with the service's message, and the dialog has no slug field.
- The member list clears its choice before the add finishes, so a failed add loses the selection.
- With the people lookup failed and every agent in the team, the list says everyone is already in.
- Name error and the capability description are not tied to their inputs with `aria-describedby`.
- Several component tests are render-only. They do not click Save, Add or Remove.
- Uppercase handles are lowercased on save, not rejected.

## Ideas beyond the scope

- Rename, archive and the "lead listens" switch on the team page (`teams.update` already takes `leadListens`).
- A New team entry in Find that opens the dialog directly, and a team link on the Roster cards (TM.8).
- A guarded config patch exposed through tRPC, so two tabs cannot overwrite each other's runtime config.

## Steps for Dom

None. The page runs on tables and procedures that TM.1 and TM.2 already put in staging and production.
