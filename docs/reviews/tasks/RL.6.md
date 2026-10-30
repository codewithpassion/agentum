# RL.6 review

## Verdict

Clean after the controller's final decision. The last reviewer found one must-fix (below), and it was applied and rechecked without another round, as the controller asked.

Checks on the final commit: `bun run check`, `bun run test` and `bun run build` exit 0, and the `drizzle` grep of `apps/web/dist/client` finds nothing.

## Rounds

1. `a9853f46`, not clean, 3 must-fix. `ownRunIds` missed runs behind open requests whose run had ended. An already answered `?item=` showed another item with live buttons. In a group, `next` was never cleared when the answer kept the URL's item. Fixed in `70858ca8`.
2. `70858ca8`, not clean, 1 must-fix. `setScope` dispatched a refresh before React re-rendered, so a fetch for the old scope could land last. Fixed in `b9d659e9`.
3. `b9d659e9`, not clean, 1 must-fix. With that dispatch gone, the toggle did not reach the open pane. Fixed in `9b4421be`.
4. `9b4421be`, not clean, 3 must-fix, all about blocked storage and a poll in flight at toggle time. The controller decided on one in-memory scope store for the rail and the pane, with `localStorage` only as persistence, and a sequence guard in `usePolledQuery`. Done in `30f210d6`, with `scope-toggle.test.tsx` covering the toggle-to-pane path with blocked storage.
5. `30f210d6`, not clean, 1 must-fix. The first sequence guard dropped any load that a newer one had started after, so a load slower than the poll interval never landed. The guard now drops only results older than the newest one that landed, and `use-polled-query.test.tsx` covers a slow load and a slow failing load. Applied without another review round.

## What changed beyond the task text

- `RailCard` gained `detail`, and `RailSources` replaced `doneAgentIds` with `done` and added `ownRunIds`. The spec's data contract and rule 2 say so.
- The scope lives in `rail-pane/scope-storage.ts` as `railScope`. `RAIL_SCOPE_EVENT` was added and then removed.
- `mail-title-text.ts` holds the pure title text so the browser can import the receipt without pulling in drizzle. `mail-subjects.ts` holds the database read. `desk.ts`, `sessions.ts` and `tasks/service.ts` share them.
- A mail task now takes its subject as its title in the Sessions list, ahead of its trigger's name.

## Receipt decision (M2)

`tasks/receipt.ts` prints `Inbound mail` for the first step when no subject is known and does not read the subject itself. The Task page swaps in the subject through `withMailTrigger` once the mail thread loads, so it reads right there, and `Inbound mail` shows only if that load fails.

## Nits left

- With blocked storage the choice lasts for the visit and survives nothing else. That is the intended limit.
- A one-person workspace forces the rail to Mine, but the pane still reads a stored Everyone (`rail.tsx:79`, `rail-pane.tsx:47`).
- A slow old-scope pane result that lands before the new one shows briefly, then is replaced.
- `Could not look for that item.` has no retry until the missing id or scope changes.
- In `rail-pane.tsx` and `rail-needs-you.tsx`, a person's own private run on a colleague's agent says `Waiting on` or `for` the owner, who cannot see it.
- Conflict, suggestion and inbox-reply cards that carry a `runId` leave the starter's Mine once that private run is no longer live, finished today or stuck. The owner still sees them.
- `needsYouCount` has no client caller left in `apps/web/src`, only its router procedure.
- A run still live after a bounced mail shows both under Needs you and under Working (RL-1 nit, rule 9).
- The other RL-1 nits not named in the task stay open: `groupKey` and the workspace's own domain, Everyone rows with nobody to ask, the Board's approval title, `/agents` failing on a bad overview, and `setOwners` outside `atomic`.

## Ideas beyond the scope

- One scope store for the whole rail would also let a one-person workspace force Mine for both the rail and the pane.
- `usePolledQuery` could take an abort signal, so a superseded load stops instead of finishing and being dropped.

## Steps for Dom

None. The M3 browser check from `docs/reviews/RL-1.md` (open a skill proposal and a thread reply in the pane and compare with the Board) was not run. `rail.test.ts` and `pane-logic.test.ts` cover `detail` reaching the band, and the controller tests on staging next.
