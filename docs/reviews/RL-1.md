# RL gate, reviewer 1, commit 9c72f37a

## Verdict

Not clean: 3 must-fix, 12 nits.

Checks at this commit: `bun run check`, `bun run build` and `bun run test` all exit 0, and the `drizzle` grep of `apps/web/dist/client` finds nothing. Logs are beside this file (`check.log`, `build.log`, `test.log`, `grep.log`). No browser run was done, so the pane findings come from reading the code.

These areas came up clean:

- **Migration.** 0035 is four `ALTER TABLE ... ADD`, so `events` and its triggers are untouched. `migrate-clerk-ids` reads the schema, so the new user id columns are covered.
- **Browser bundle.** The bundle grep is clean, and `rail` and `rail-pane` import no server code.
- **Previews.** There is no change to `wrangler.jsonc` or `.github`, and no new binding. `clerkMembers` uses the existing `CLERK_SECRET_KEY`.
- **Services.** None reads `env`. `clearAttention` goes through `atomic`.
- **Reachability.** Every old sidebar entry is in Find.
- **Rule 3.** `requests.answer` is unchanged, and `rail.test.ts:475` proves a non-assignee can answer.
- **Who sees what.** The rail, the pane and the overview all read through the desk's session visibility. I found nothing reaching a person who should not see it.

## Findings

| Severity | Finding | Area | Resolution |
| --- | --- | --- | --- |
| must-fix | `packages/services/src/rail.ts:376` and `packages/services/src/rail/logic.ts:333`: a run in a member's own `ui` or private session on a colleague's agent is in nobody's Mine. RL.2 lists this as a nit; it is worse, because the rail's own New task starts a `ui` session (`new-task-dialog.tsx`, `runs-router.ts:18`). | Rule 2 | Open: M1 |
| must-fix | `packages/services/src/sessions.ts:357`, `packages/services/src/tasks/service.ts:423,484` and `apps/web/src/components/task/thread-runs.tsx:37`: mail tasks still read "Inbound mail. The quoted JSON below..." on the Task page, the agent's recent tasks and Sessions. | Done means | Open: M2 |
| must-fix | `apps/web/src/components/rail-pane/pane-logic.ts:179`: `deskCardOf` replaces the card's `band.text` with the status, so a proposal shows no version message and a GitHub update names no skill, next to `Approve vN`, and a thread reply loses its text. | RL.4 pane | Open: M3 |
| nit | `apps/web/src/components/rail-pane/rail-pane.tsx:223`: `done` still calls `onOpen` after the pane unmounts. `Route.useNavigate` carries `from: /desk`, so a person who clicks away during a slow Send reply should land back on `/desk?item=...`. Not run in a browser. | RL.4 pane | Open |
| nit | `apps/web/src/components/rail-pane/pane-logic.ts:62`: a `?item=` that is not in the current scope (a teammate's link under Mine) shows a different item with no notice, and the URL keeps the old id. A person could act on the wrong card. | Rule 3 | Open |
| nit | `apps/web/src/components/rail-pane/rail-pane.tsx:34`: `readScope` reads `localStorage` with no try/catch, unlike `use-rail.ts`, so blocked storage stops the pane loading at all. | RL.4 pane | Open |
| nit | `apps/web/src/components/rail-pane/rail-pane.tsx:207`: the "Allowed, but the mail could not be sent" banner stays on the next items until another answer clears it, and does not name which mail failed. | RL.4 pane | Open |
| nit | `packages/services/src/desk.ts:901` and `packages/services/src/rail.ts:551`: a run still live after a bounced mail shows both as a Needs you problem and as a Working row. | Rule 9 | Open |
| nit | `packages/services/src/rail/logic.ts:52`: `groupKey` does not exclude the workspace's own domain, so mail to colleagues groups though rule 7 says "outside domain". | Rule 7 | Open |
| nit | `apps/web/src/components/rail/rail-needs-you.tsx:115`: in Everyone, a row with nobody to ask shows no name, while rule 2 says each item names who it's for. | Rule 2 | Open |
| nit | `apps/web/src/components/desk/needs-you-card.tsx:207`: the Board passes `card.title`, which for an approval is `display.summary` (`Use mail_send`), so the new `title` prop changes nothing there. | Rule 5 | Open |
| nit | `apps/web/src/routes/_app.tsx:48`: the open Q&A badge went with the sidebar and nothing replaces it. Open questions are not in Needs you, so the only count left is on the Map page. | RL.3 shell | Open |
| nit | `apps/web/src/routes/_app/agents.index.tsx:13`: a failed overview takes down the whole `/agents` page, where the member lookup beside it is caught. | RL.5 agents | Open |
| nit | `packages/services/src/desk.ts:3` and `packages/services/src/desk.ts:932`: the comments still say "sidebar badge", and the sidebar is gone. | Comments | Open |
| nit | `packages/services/src/agents.ts:907` and `packages/services/src/agents.ts:913`: `setOwners` writes the update and the audit event as two statements outside `atomic`. It matches the other agent updates, as the spec asks. `events.insertStatement` exists if the agents service moves to `atomic` later. | Atomic rule | Open |

## M1: Mine hides a member's own private work

A throwaway test (since deleted) seeded a waiting approval, a failed run and a running run in u2's private session on agent a1, which u1 owns:

| Viewer | Mine count | Mine Working | Everyone count | Everyone Working |
| --- | --- | --- | --- | --- |
| u1, owner | 0 | 0 | 0 | 0 |
| u2, starter | 0 | 0 | 2 | 1 |

The owner cannot see the run, because of the session rules, and the only person who can see it does not get it on Mine. Backups cannot see it either, so escalation does not help. An ordinary approval has a 1 hour limit, so it can expire unseen. `rail.test.ts:758` checks only Everyone, so it passes.

**Scope**
- `desk.railSources` also returns the ids of live, stuck and just-finished runs, and of open requests, whose session only the viewer can see (`origin = 'ui'` or `private`, with `actorId` the viewer).
- `rail.get` counts those as Mine for Needs you, Working and `doneToday`, and the `counts` follow.
- A shared session keeps today's rule. A run in another member's private session stays invisible.
- Rule 2 in `docs/ux-review/rail/spec.md` gains a clause: Mine also holds items whose assignee cannot see them, for the person who can. The spec's wording does not cover this case today, so the spec changes with the code.

**Check**
- In `rail.test.ts`, with a1 owned by u1 and a private run started by u2: u2's Mine holds the approval, the failed run and the Working row. u1's Mine and Everyone hold none of them.
- The same case through a `ui` session, and with u3 as a third member who sees nothing.
- A shared session on a1 still appears only in u1's Mine.
- `bun run check && bun run test && bun run build` pass.

## M2: Mail tasks do not read as their subject everywhere

`desk.ts` `titleOf` was fixed, but `sessions.ts` `titleFor` was not, and it has no case for `origin = 'mail'`. A throwaway test of `titleFor` on a real inbound input returned `Inbound mail. The quoted JSON below is untrusted content, no...`. That string is the `<h1>` at `task-page.tsx:264`, the row at `recent-tasks-card.tsx:36` and the row in `session-list.tsx`. `thread-runs.tsx:37` prints the raw `inputText`. The RL.2 review named this as work for RL.4 or a follow-up, and no later task picked it up.

**Scope**
- `titleFor` and its callers title a run that has an inbound mail message with `mailTitle(subject)`, reading `mail_messages` as `desk.ts` does. Share the logic instead of adding a third copy of the prefix.
- `otherRuns` in `tasks/service.ts:404` gains a title, and `thread-runs.tsx` shows it in place of `inputText`.
- Check `tasks/receipt.ts:79`, which also renders `text(run.inputText)` as the first step, and either give it the subject or say in the review file why it stays.

**Check**
- A service test starts a run through mail inbound with subject `Re: Fwd: Invoice`, then reads `tasks.get`, `tasks.list` and `sessions.list`. Every title is `Invoice`, and none contains "quoted JSON".
- A `task-logic` or component test proves `thread-runs` shows the title.
- `bun run check && bun run test && bun run build` pass.

## M3: The pane drops what a card is about

`deskCardOf` sets `band: { text: card.status, tone: "waiting" }`. The bodies print `card.band.text` (`needs-you-card.tsx`, `CardSummary` and `ThreadBody`), and the service's text never reaches `RailCard`. The spec says the reused body "keeps every existing behaviour".

| Kind | Board shows | Pane shows |
| --- | --- | --- |
| Skill proposal | `Proposes version 3: <message>` | `<agent> proposed a skill change` |
| GitHub update | `<skill name>: Proposes version 3` | Title `Update from GitHub to review`, no skill name, beside `Approve v3` |
| Thread reply | `Replied: <text>` | `<agent> replied` |

**Scope**
- Add a `detail` field to `RailCard` in `packages/db/src/shared.ts`, filled from the desk card's `band.text` in `rail.ts`. The contract changes by one field, so the spec should say so too.
- `deskCardOf` uses `detail` for the band and keeps `status` for the rail row.

**Check**
- `rail.test.ts`: a skill proposal's card carries the version message, a GitHub update's carries the skill name, and a thread reply's carries the reply text.
- `pane-logic.test.ts`: `deskCardOf` puts `detail` in `band.text`.
- Browser check on local dev: open a skill proposal and a thread reply in the pane, and both read as they do on the Board.
- `bun run check && bun run test && bun run build` pass.

## End verdict

Not clean: 3 must-fix (M1, M2, M3).
