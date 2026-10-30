# RL.4 review: The main pane

## Verdicts

- Round 1, `1c06b5cc`: not clean, 4 must-fix. A bare `/desk` re-picked the first item on every poll (rule 10). Takeover Cancel never reached the move-on. `/desk?agent=X` no longer reached the board. The mail view hid the Cc recipients.
- Round 2, `3ee2218e` (fix commit): not clean, 2 must-fix, both regressions from a `shown` state. A URL item the pane's list did not have yet was lost, and Back to a bare `/desk` kept the old item.
- Round 3, `03457039` (fix commit): not clean, 2 must-fix. A stale `next` could survive until Back reached a bare `/desk`. When the URL item was gone, the fallback item was not held. After two fix rounds the controller decided: fix the first, record the second as a nit (it needs two unlikely events in a row).
- Round 4, `704ae1d1` (changes since round 3: the stale-`next` guard, the phone list, the URL pin): not clean, 2 must-fix. The URL pin's replace navigation could override a navigation already in progress. The phone list was not "the same list" as the rail (no due label, status, `for <name>`, `asked you too`, `passed on by`). Both were fixed in the last commit by waiting for the router to settle before pinning and by reusing the rail's own `NeedsYouRow` and `SetupRow`. That commit was not reviewed again, as the controller asked for one more reviewer only. The rest of round 4 was nits.

## What was built

- `components/rail-pane/`: `RailPane` (own poll of `desk.rail`, `requests.pending` and `skillStore.proposals`), `CardView`, `MailDecision`, `ProblemBody`, `SetupPane`, `HowItGotHere`, `InlineList`, and the pure `pane-logic.ts` and `answer.ts` with tests.
- `desk.tsx` shows the pane, or today's board with `?view=board` or any `?agent=` link. `NeedsYouBody` is exported, and `RequestCard` takes an optional `title` (the board passes the card title) and `onClosed` (takeover Cancel).
- Mail decision: heading, who it goes to (with Cc), `They wrote`, the reply in body type, `Send reply` (allow once), `Not this time` with `Tell it what to change`, `Always send to this address`, `Waiting on <name>`, and the expiry only under 4 hours. A failed send shows the Desk's message.
- After any action the pane hides the answered card, dispatches `RAIL_REFRESH_EVENT` and opens the next item. A grouped item stays open under its first remaining card.
- A bare `/desk` on a desktop puts the shown item into the URL (replace), so the rail highlights it and a new item that sorts first cannot move it. A phone with no `item` shows the rail's own rows inline.

## Checks

- `bun run check`, `bun run test` and `bun run build` pass, and the `drizzle` grep of `apps/web/dist/client` is clean.
- Browser, local dev, 1440x900 and 390x844, seeded rows: each kind (mail approval and a group of two, question, non-mail approval, failed run, setup step), Send reply, Not this time with a note, Allow once and Dismiss moving on to the next item, a failed send showing its error, the expiry showing at 2 hours, no `Use mail_send` heading and no monospace reply, `?agent=` reaching the board, the phone list and the desktop pin.
- A guest-execution test (`guest-execution.test.ts`, miniflare) failed once in a full run while other dispatchers ran, and passed alone straight after. It is not touched by this task.
- Reviewers also ran scratch happy-dom and real-router harnesses (in `tmp/RL.4/harness/`). None is committed, because `mock.module` leaks across test files in bun.

## Choices where the spec was silent

- The non-mail approval's `title` prop is the card status ("Needs your OK"), because the pane heading already shows the title.
- A problem with no `runId` shows no Dismiss. The service always sets one today.
- The pane reads the scope from `hm:rail-scope` itself and refetches on `RAIL_REFRESH_EVENT` and its own 10 second poll.
- `Waiting on` shows only when the item names a person.

## Nits left

- When the URL item is gone (answered by someone else, or expired) and a new item then sorts first, the pane moves to it. It needs two unlikely events in a row. Holding the fallback would fix it.
- The pin fires `onOpen` twice per pin, and `held` now only covers the moment before the URL catches up.
- A phone that rotates to 768 px or wider gets pinned and stays on the item after rotating back. Answering the last item opened from the phone list leaves two `/desk` history entries.
- The pane reads the stored scope directly, while the rail forces Mine for a one-member workspace. The scope toggle sends no refresh event, so the pane can lag the rail by up to 10 seconds. Having the toggle dispatch `RAIL_REFRESH_EVENT` fixes it (RL.3 code).
- `SetupRow` in the rail has no open state, so a pinned `?item=setup:...` gets no highlight (RL.3 code). Rail setup rows link to Settings, not to the pane's setup items.
- Questions and takeovers still show "expires in N h" through `RequestCard`, whatever the time left. A non-first card's heading and the body can repeat a title for proposals.
- "An email started this" is used for any mail approval, and it uses the card's time. `RailCard` has no actor, so a person-started run reads as agent-started.
- The Cc list comes from `requests.pending`, so a missing request shows the mail without Cc.
- `usePolledQuery` has no sequence guard (the pane hides answered cards, so only other lists are affected). `answered` is never cleared until the pane remounts.
- Pane-level behaviour (hold still, bridge after an answer, the `agent` branch) has no committed test.

## Ideas beyond the scope

- A controlled hold of the fallback item, and a real-router component test harness that does not use `mock.module`.
- A per-run cost line under `How it got here`, if a cost is stored.

## Steps for Dom

None. A worktree dev server needs `ARTIFACT_VIEW_KEY` in `apps/web/.env.local`, or `/desk` fails with "A private room ticket key is required".
