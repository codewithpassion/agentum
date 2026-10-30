# RL gate, round 2, commit 0f60c33f

## Verdict

Not clean: 2 must-fix (M4, M5), 2 nits. M1, M2 and M3 are fixed. M4 and M5 are regressions from RL.6.

Checks at this commit: `bun run check`, `bun run test` and `bun run build` exit 0, and the `drizzle` grep of `apps/web/dist/client` finds nothing. Logs are beside this file (`RL-2-*.log`). I ran no browser, so the M3 browser check from `RL-1.md` has still not been run by anyone in these reviews. M4 and M5 were reproduced with throwaway tests in `scratch/` beside this file.

## Round 1's must-fixes

**M1 is fixed.** `desk.railSources` returns `ownRunIds`, and `rail.get` counts them as Mine for Needs you, Working and `doneToday`. `rail.test.ts:841` covers a private and a `ui` session: u2 holds the approval, the failed run and the Working row, and u1 and u3 hold none in either scope. A shared session stays with the owner (`rail.test.ts:894`). Rule 2 in the spec changed with the code.

**M2 is fixed.** `tasks.get`, `tasks.list`, `sessions.list` and `desk.get` share `mail-subjects.ts` and `mail-title-text.ts`, and `mail-titles.test.ts:189` runs a real inbound mail through them. The fix to `thread-runs.tsx` caused M5.

**M3 is fixed in code.** `RailCard.detail` carries the desk card's band text, and `deskCardOf` uses it. The two places `needs-you-card.tsx` prints the band (lines 45 and 63) therefore read as on the Board. `rail.test.ts` and `pane-logic.test.ts` cover it.

## Findings

| Severity | Finding | Area | Resolution |
| --- | --- | --- | --- |
| must-fix | `apps/web/src/components/rail-pane/rail-pane.tsx:240` and `apps/web/src/components/rail-pane/use-elsewhere.ts:13`: clicking a new rail row before the pane's own poll has it shows a false message for up to 10 seconds. Under Mine it says `That item is under Everyone, not under Mine.`, and under Everyone it says `That item is not waiting any more.` | RL.4 pane | Open: M4 |
| must-fix | `packages/services/src/tasks/service.ts:412`: `otherRuns` titles come from `titleFor`, which returns the session's name for an inbox or trigger session, so every row under `Earlier in this thread` and `Later in this thread` reads the same. | M2 fix | Open: M5 |
| nit | `apps/web/src/components/rail-pane/rail-pane.tsx:240` and `apps/web/src/components/rail-pane/pane-logic.ts:40`: with `?item=A` open on a group of A and B, if a teammate answers A or it expires, the pane says `That item is not waiting any more` while B still waits. The server's row id moves to B, and the URL still names A. `Open what is waiting` recovers. | RL.4 pane | Open |
| nit | `packages/services/src/rail.ts:340` and `apps/web/src/components/rail-pane/mail-decision.tsx:76`: on a new thread to someone other than the sender, `They wrote` quotes the original sender with no name, under `Reply to Bob`. It reads as if Bob wrote it. RL.7 asked for this quote, so only the unnamed attribution is the problem. | RL.7 | Open |

## M4: A new rail row can claim its item is gone

The rail and the pane poll separately, each every 10 seconds, with a fixed gap set by when each one mounted. `RailPane` does not refetch when `item` changes, so `missingItem` judges a fresh URL against an old list. `useElsewhere` then assumes "Mine is the only scope a missing item can be under". Under Mine it queries Everyone, finds the item and reports the wrong place. Under Everyone it reports `gone` with no fetch at all.

A throwaway test (`scratch/fresh-row.test.tsx`) mounts the pane, adds an item on the server, then sets `item` to it:

| Scope | Pane shows |
| --- | --- |
| Mine | `That item is under Everyone, not under Mine.` and `Show Everyone` |
| Everyone | `That item is not waiting any more.` and `Open what is waiting` |

It corrects itself on the next pane poll, and the buttons are not live on a wrong card. I still rate it must-fix because this is the rail's main path: a mail arrives, the row appears, and the person clicks it. The message is false, and `Show Everyone` moves them to the wrong scope and stores that choice. Before RL.6 the same race showed the first item.

**Scope**
- Before the pane says an item is missing, it refetches its own scope. `RailPane` calls `refresh` once when `missing` first becomes a new id, and shows `Looking for that item.` until a load that started after that point lands.
- A simpler option meets the same check: refetch the pane on every `item` change.
- `useElsewhere` runs only after that refetch still does not list the id. This covers both scopes, including the `scope === "everyone"` path that returns `gone` at once.
- Fix the comment in `use-elsewhere.ts`, which is the wrong assumption.

**Check**
- A component test in the style of `scope-toggle.test.tsx`: with a pane loaded and a new item on the server, setting `item` to it shows the card under both Mine and Everyone, and `under Everyone` and `not waiting any more` never appear in the DOM. Assert this on each render, for example with a `MutationObserver`, or hold the refetch open and assert `Looking for that item.`
- `scope-toggle.test.tsx` still passes, so an item truly under Everyone still offers `Show Everyone`, and a gone id still says so.
- `bun run check && bun run test && bun run build` pass, and the `drizzle` grep of `apps/web/dist/client` finds nothing.

## M5: Thread rows lost what each run was about

`titleFor` puts `sourceName` ahead of the input, and that is right for a session title. `otherRuns` now uses it per run. `thread-runs.tsx` shows no time, so the status pill is the only difference between rows. An inbox thread starts one run per post in one session (`inbox.ts:442`), and `buildWakeInput` starts with the post's text, so these rows used to show each post. Now every row shows the thread title. A throwaway test of `titleFor` (`scratch/thread-title.test.ts`) returned `Deploy question` for both `first reply` and `second reply`, and the same for a trigger's name. Slack sessions keep their text, because a label only prefixes it.

**Scope**
- In `tasks/service.ts:412`, title each other run with `runTitleText(other.inputText, subjects.get(other.id))`, clipped the way `titleFor` clips, and not with `titleFor`. A mail run still reads as its subject and never as the notice.
- Keep `titleFor` for the page title and `tasks.list`. `tasks.list` used it per run before RL.6, so it is not part of this regression.

**Check**
- A service test: an inbox session with two runs, read through `tasks.get`. Each `otherRuns` title holds that run's post text and differs from the other.
- `mail-titles.test.ts` still shows the subject for a mail run in `otherRuns`, and `quoted JSON` never appears.
- `bun run check && bun run test && bun run build` pass, and the `drizzle` grep of `apps/web/dist/client` finds nothing.

## End verdict

Not clean: 2 must-fix (M4, M5).
