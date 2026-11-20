# DR.6 browser check, round 2: Dream diary on the Knows tab

Branch `task/DR.6-dream-diary-ui` at a1e4afb7cebbd888bb3a66356d870f0f7b5ed720, run with `vite dev` on port 3926 against the local D1 database. Headless Chromium through agent-browser. Desktop is 1280x800, phone is 390x844. The owner session (`dr6-verify`) signed in as Dev User through `/api/dev-login` (admin of Dev Workspace, owner of Scout). The member session (`dr6-verify-member`) signed in as `dev+member@harbouredgeintelligence.ai` with `bun run agent-login`; the page confirmed that user. The page under test is `/agents/01DR6SCOUT00000000000000AA?tab=knows`.

This run used the local fixture (`dream.ts` plus `desk-rail.patch`), because the dream service (DR.4) is not on main. Dream now therefore ran a fixture, not the real dream (DR.4 is the real one). The fixture files "Dream now" as one done run and, when the agent has two applied notes, an open question. Its Undo only marks the run and its `memory_changes` rows as undone. It restores no note, so "The notes are back as they were" was not true of the note list here. That is a fixture limit. The fixture was removed afterwards.

Setup. Round 1 had left Scout archived with old dream rows. Before flow 1 I unarchived Scout, deleted every `dream_runs` and `dream_questions` row and set `dream_run_id` back to null in `memory_changes`. All D1 seeding was done with the page on `about:blank`, so no page request was in flight. No SQLITE_BUSY or other 500 showed up. The notes, edits and forgets were made through the Knows tab, so the library versions are real. Two early notes carry a stray "--name Note" in their text, from a typo in my own command; it is test data only. `agent-browser wait --load networkidle` never settles on this page because of the polls, so I used fixed waits. To see the in-progress labels I wrapped `window.fetch` in the page to delay the `runNow`, `undo` and `rules` calls by a few seconds, because the fixture answers in milliseconds.

## 1. No dreams yet

Steps: clean state, open the Knows tab, read the card, measure it.

Desktop: `[data-slot="dream-card"]` is the first thing in the tab panel, before "What Scout remembers". The card has `data-state="none"`. Its text says "Scout has not dreamed yet. A dream reads what happened since the last one, tidies the notes and writes a diary entry here." Dream now and the Dream schedule radios (Nightly checked, Weekly, Off) are visible. scrollWidth 1280, nothing in the card overflows. Heading order is H1 Scout, H2 "Dreaming", then the other H2s.

Phone: same content in one column, card 358 wide, scrollWidth 390.

Screenshots: `desktop-1.png`, `phone-1.png` (full page).

## 2. Dream now, read the diary, answer a question

Desktop: added "Reports go out on Tuesday desk" and "Reports go out on Monday desk" on the Knows tab, then clicked Dream now. The run finished before I could read the button, so the in-progress label was checked on the phone. The card then read "Today's dream", the diary "Reviewed the recent conversations with the fake model. Two notes disagree and I could not settle it. One question for you.", "Nothing changed." and "It asked you one question." with the link "Open Needs you". That is the round 1 fix: the card states what the dream did and no longer claims a question is open. There is no Undo this night on this card, because the night changed nothing (round 1 fix confirmed). The link opened `/desk?item=...`. The Needs you drawer lists "Which of these is right?" with "Scout has a question from its dream". The pane shows the question, "These two notes disagree. Keep the one that is right and the dream drops the other." and the two notes, each with a Keep this one button. Both buttons have an accessible name that includes the note text, for example "Keep this one: Reports go out on Monday desk --name Note". I clicked Keep this one on the second note (Tuesday). The pane moved to "Nothing needs you" and the Needs you count went to none. D1: the question is `answered`, `answered_by` is the owner, and `answered_note_id` equals the Tuesday option's note id.

Phone: added "Phone reports go out on Tuesday" and "Phone reports go out on Monday", delayed `runNow` by 4 s and clicked Dream now. While it ran the button read "Dreaming…" and was disabled, and so were the three schedule radios. Then the same done card appeared, and the button was back. On a phone the link "Open Needs you" lands on the Needs you list (`/desk`), and one more tap on the item opens the question. On desktop the first item opens by itself. The two Keep buttons have names with the note text. Keep this one on the second note (Tuesday) gave "Nothing needs you". D1: `answered`, `answered_note_id` is the Tuesday note.

Screenshots: `desktop-2.png` (card), `desktop-2b.png` (question pane), `desktop-2c.png` (drawer), `desktop-2d.png` (after answering), `phone-2a.png` (Dreaming…), `phone-2.png` (done card), `phone-2b.png` (Needs you list), `phone-2c.png` (question), `phone-2d.png` (after answering).

## 3. See changes with before and after

Desktop: I edited "Lunch is at 1pm" to "Lunch is at 1:30pm" through Edit and Save, added "Team offsite is in March", and forgot "Standups are at 10am". I deleted the fixture runs, inserted a done run (started 02:00 local, diary "Reviewed 14 conversations. Added 1 note, changed 1, dropped 1.", counts added 1, merged 1, dropped 1) and pointed the three change rows at it with `written_by = 'dream'`. After a reload the newest card was "Last night's dream" with that diary and the counts line "Added 1 note, merged 1, dropped 1.", Undo this night and See changes. See changes listed: Changed a note, Before "Lunch is at 1pm", After "Lunch is at 1:30pm"; Added a note, After "Team offsite is in March" only; Dropped a note, Before "Standups are at 10am" only. The Before text is the real old text. Hide changes closed the list.

Phone: edited "Invoices are paid on Thursday at noon" to "... at 1pm", added "Phone: board meets on Fridays", forgot "Reports go out on Monday at 9am", seeded a second run the same way. The card showed the same three rows with the right Before and After text. The card had no horizontal overflow.

Screenshots: `desktop-3.png`, `phone-3.png`.

## 4. Undo this night

Desktop: Undo this night with the call delayed 3 s showed "Undoing…" (disabled, and Dream now was disabled too). Then the card was `data-state="undone"`: "You undid this night. The notes are back as they were." (see the fixture note), the diary in grey, no Undo button. See changes still worked and each row carried "Undone." Dream now worked afterwards and produced a new done card, with no Undo because it changed nothing.

Phone: the same, including the "Undoing…" state, the three rows marked "Undone.", and Dream now working afterwards.

Screenshots: `desktop-4.png`, `phone-4a.png` (Undoing…), `phone-4.png`.

## 5. Earlier dreams

Inserted older runs: done (yesterday, with a diary of a long unbroken string), skipped (empty diary), failed (error "The model call failed."), undone, plus the two undone runs from flows 3 and 4. The newest run is the card and not in the list. The list shows each row with its day, a badge and a line: "Yesterday, Done, Merged 2.", "2 days ago, Skipped" (no line, since the diary is empty), "3 days ago, Failed, The model call failed.", "4 days ago, Undone". See changes is on done and undone rows only. On the seeded rows it opens either the change rows with "Undone." or "This dream changed no notes." for runs with no change rows.

Desktop and phone both fit with no overflow. I also set the newest diary to a very long unbroken word plus a long URL: it wraps at both sizes (scrollWidth equals the viewport, `scrollX` stays 0 after `scrollTo(500, 0)`). Round 1 sideways scroll is fixed.

Screenshots: `desktop-5.png`, `desktop-5b.png` (two rows expanded), `phone-5a.png` (long diary and list start), `phone-5.png`.

## 6. Schedule control

Desktop: with the `rules` call delayed 3 s I chose Weekly. During the save Dream now and all three radios were disabled, and the old choice stayed shown until the save finished. After a reload Weekly was checked. Off, reload: Off checked. Nightly, reload: Nightly checked. The other rules in `agents.remember` (learn level, share with team) stayed intact.

Phone: Weekly (radios disabled during the save), reload, Weekly; Off, reload, Off; Nightly, reload, Nightly.

Screenshots: `desktop-6b.png` (Off after reload), `desktop-6.png` (Nightly after reload), `phone-6b.png`, `phone-6.png`.

## 7. A member cannot change it

Setup: reused the member from ME.6; the session page confirmed `dev+member@harbouredgeintelligence.ai`. To test the Undo rule I made the newest run a done run that added a note.

Desktop: the dream card and the diary are visible ("Reviewed 6 conversations. Added 1 note." and the counts line). There is no Dream now, no schedule radios, no Undo this night. See changes works and shows "Added a note, After Team offsite is in March". A plain line "Dreams nightly." replaces the controls. The same night as the owner showed Undo this night, so the gating is by role. Learned this week still offers Undo buttons to the member, which comes from ME.6, not DR.6.

Phone: the same.

Server check, beyond the UI: as the member I called `dream.runNow` and `dream.undo` directly over tRPC. Both answered 200 and did the work. The fixture's `authorize` call, and the stub's, only checks that the principal is in the workspace, so this says nothing against the DR.6 UI, but nothing in the DR.6 diff checks the role either. The real dream service (DR.4) has to refuse a member, as `memory.rules.set` does with 403. These two probes were mine, not the page's. I removed the extra run and restored the undone night afterwards.

Screenshots: `desktop-7.png`, `phone-7.png`.

## 8. An archived agent

Archiving was cheap (Settings, Archive agent, Archive). On the Knows tab of the archived agent the card is still visible with the diary and See changes. Dream now and all three radios are disabled, not hidden (accepted), and there is no Undo this night even though the night added a note. Same at phone. I restored the agent afterwards through the Restore button, and the controls came back.

Screenshots: `desktop-8.png`, `phone-8.png`.

## Layout, headings, keyboard

At both sizes, in every state I measured (none, done, undone, member, archived, long diary): `scrollWidth` equals the viewport (1280 and 390), the card has no overflowing child, and the card is the first element in the tab panel. Headings: H1 Scout, H2 the card heading ("Dreaming", "Today's dream", "Last night's dream"), H3 "Earlier dreams", then H2 "What Scout remembers" and the rest. Keyboard (owner, desktop): Tab from the tab strip reaches Undo this night, See changes, Dream now, the schedule radio group (one stop, as native radios), then each Earlier dreams See changes in turn, then the notes' Edit and Forget. Every button is reachable.

## Console and network

After each flow I read `agent-browser console` and listed resources with `responseStatus >= 400`, or status 0 on same-origin requests, from the Performance API.

- Owner session: no console error and no failed request in flows 1 to 8. The 400 during first sign-in did not show up this time.
- Member session: no console error and no failed request from the page. The only failures were my two direct probes in flow 7 (they returned 200, see above), so there were none to exclude.
- Warnings only: Clerk's development keys, software WebGL fallback, "No available adapters" (out of scope).
- Dev server log: no errors, no SQLITE_BUSY.

## Findings

1. Server side, for DR.4: a member can call `dream.runNow` and `dream.undo` and succeed (flow 7). The UI hides the controls, but the role check must also be in the service.
2. Earlier dreams show the counts sentence (for example "Merged 2."), not the diary text of that night, so a past diary can no longer be read anywhere. Say if that is intended.
3. Several buttons are named just "See changes" (the card and every earlier row). A screen reader user cannot tell which night a button opens, and a test cannot target one by name.
4. The card heading in the "none" state is "Dreaming", which reads like a dream in progress. The text under it says it has not dreamed yet.
5. On a phone, "Open Needs you" lands on the Needs you list and one more tap opens the question. On desktop it opens the question.
6. Cosmetic: See changes sits indented against the text above it, in the card and in the list rows.
7. Not DR.6: in dev builds the floating TanStack Devtools button covers the bottom-right of the page, as it did in ME.6.

Verdict: pass
