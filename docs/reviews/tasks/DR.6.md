# DR.6 review

## Verdict

Round 1, commit 04b3445b: clean. No must-fix findings, 16 nits. The dispatcher applied the cheap ones in 0c1e36fa: Dream now stays off while the latest dream runs, the dream actions stack instead of sharing a row with the change list, long text wraps, and each Keep button's accessible name carries its note text.

Browser proof round 1, at 0c1e36fa: fail. Three defects, fixed in a1e4afb7. The Before text was always empty, because the library path (`agents/<slug>/memory/people.md`) went to the codec, which wants the path inside that folder, and the unit test used a short path so it hid this. A long unbroken diary string made the phone page scroll sideways. Undo this night showed to members and on a night that changed nothing, and the question line kept saying "One question for you" after the answer.

Browser proof round 2, at a1e4afb7: pass at 1280x800 and 390x844, no console errors, no failed page requests. See `docs/reviews/tasks/DR.6/browser.md`. It ran against a local fixture dream service, because DR.4 is not on main (below).

Round 2, commits 0c1e36fa to 98714f32 (the nit fixes, the browser-proof fixes, the merge of main): clean. No must-fix findings, 5 nits, listed below.

## What was built

- `components/agent/room/knows/dream/`: the dream card with its states (none, running, skipped, failed, done, done with a question, undone), See changes with before and after text read from the library versions, Undo this night, the earlier dreams list, the schedule choice, Dream now, and `use-dream.ts` for the data. `knows-layout.tsx` and `index.tsx` mount it in the slot ME.6 left. `useMemory` gained `reload`, so a dream or an undo refreshes the notes.
- `components/rail-pane/dream-question.tsx`: the `dream_question` item in the Needs you pane, with its notes and a Keep this one button per note. `card-view.tsx`, `pane-logic.ts` and `rail-pane.tsx` route it and call `dream.answer`.
- Dream now, the schedule choice and Undo this night show for the owner and admins only (the same `canChange` as the rules). The schedule saves through `memory.rules.set`, as `dreamSchedule` is a remember rule.

## Nits left

- Earlier dreams show the counts sentence, not that night's diary, so an old diary cannot be read. A done or skipped row should show its diary too.
- Every See changes button has the same accessible name. Give each one the night it opens.
- The card heading with no dreams reads "Dreaming", which sounds like one in progress. "Dream diary" fits better.
- On a phone, Open Needs you lands on the list and needs one more tap. On desktop it opens the question.
- Open Needs you, Undo and the question line read `counts.questions` from the run, which only says what the dream asked. Whether a question is still open needs a `dream.questions` read from DR.4.
- `use-dream.ts` has no tests (polling, error, a slow reply for another agent), and nor does the open, loaded and failed state of See changes.
- An error from a failed schedule save shows under What it remembers, not next to the dream card, because `memory.setRules` owns that error.
- The dream card waits for the memory data. If the memory load fails the dream card never shows.
- A dream started at 23:00 local is titled "Yesterday's dream", not "Last night's dream".
- The `readVersion` comment in `dream-changes.ts` says null text means a delete tombstone. A tombstone throws, and null means binary or oversize bytes.

- The round 2 nits: the schedule picker is also disabled while a dream runs, which is harmless. `canUndoRun` counts added, merged and dropped, so an edit-only night would hide Undo (DR.4 must count an edit as merged or add an edit count). The memory folder prefix in `dream-changes.ts` repeats `memoryFolderOf` and will not match `teams/<slug>/memory/` once team memory lands. The Keep button's `aria-label` has no test and carries the full note text. The prefix strip is tested only for `people.md`, not for `private/user_x.md`.

## For DR.4 and the controller

- The browser proof used a fixture that is not committed: `/home/roboto/devel/harbourmaster-wt/tmp/DR.6/fixture/` (a stand-in `dream.ts` that reads and writes the real dream tables, and `desk-rail.patch` that makes the rail emit open dream questions with the `dream` field). DR.4 owns both pieces: a rail source for open `dream_questions` that fills `DeskCard.dream` and passes it to `RailCard.dream`, and the service itself.
- The service must check the role. In the browser proof a member could call `dream.runNow` and `dream.undo` over tRPC and both succeeded, because the stub only checks workspace membership. The UI hides the buttons, which is not the check.
- A held dream (`ask_first`) shows "Held for your approval." on its rows, but nothing in DR.6 or the plan builds the Approve and Reject buttons that call `dream.decide`. The Knows tab shows held notes with Approve and Reject, and `memory.decide` will refuse a dream's rows after DR.4. Name an owner for the dream-level buttons. Undo this night is also offered on such a run.
- The Needs you count in the drawer does not include dream questions until DR.4 adds them to `needsYouCount`.
- A dream's `usage` does not count against the spend cap yet (noted by DR.1).

## Steps for Dom

- None. No migration, secret or dashboard change.
