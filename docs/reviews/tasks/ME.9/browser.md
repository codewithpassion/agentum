# ME.9 browser verification

Independent walkthrough of flows A to E in a real headless Chromium (agent-browser), driven against the local dev server on http://localhost:3917 with the Rust daemon "me9" connected. Nothing in source was edited. Date of run: 2026-11-20, about 18:38 to 19:03 AEDT.

- Sizes: desktop 1280x800 and phone 390x844. After each size change every page was reloaded (fresh `open`). Phone flows were driven at 390x844, not inferred.
- Sign-ins: admin = Dev User (`/api/dev-login`, session `me9-verify`). Member = Member Tester `dev+member@harbouredgeintelligence.ai` (Clerk id `user_3MLzrHwgcyG5ABwkRhvqdF8hoxg`, confirmed through `window.Clerk.user`), session `me9-member`, signed in with a one-time `agent-login` URL (needed `--base-url http://localhost:3917`; the default redirect points at port 3000).
- Agents: mem-fake (fake runtime), mem-cloud (cloud, scripted `faux` model), mem-claude (cloud, real Anthropic model), mem-machine (real daemon plus Claude CLI).
- Markers used: "Desktop-..." for desktop notes, "Phone-..." for phone notes.
- Screenshots are in this folder, desktop-1..30.png and phone-1..24.png. Each is described at the end of this file.
- Horizontal scroll: `document.documentElement.scrollWidth` was read on every phone page (agent page, Knows tab, thread, desk item, Needs you drawer, Library folder and file, member pages). It was 390 every time. Desktop pages read 1280.
- Tooling notes: `agent-browser network requests` records URLs but no status codes, so failed requests were found through the console log (Chromium prints every 4xx/5xx fetch there), `performance` entries, a direct `fetch` probe, and the dev server log. `wait --load networkidle` never settles on this app (long-lived connections), so I used fixed sleeps and polling.

## Results table

| Flow | Desktop | Phone |
|---|---|---|
| A fake runtime, remember and reuse | PASS | PASS |
| B ask_first, agent calls remember, approve and reject from Needs you | PASS (with a UX finding) | PASS (same finding) |
| C private note invisible to the second member | PASS | PASS |
| D real machine agent, library sync | PASS | PASS |
| E real cloud agent (Anthropic model) | PASS | PASS |

Functionally all ten cells passed. The overall verdict is still FAIL under the strict rule, see the end of this file.

## A. Fake runtime, remember and reuse (mem-fake)

Desktop
1. New conversation on mem-fake, sent "Desktop-A1: the printer room is on level 3". Reply: "Echo: Desktop-A1: the printer room is on level 3 / I remember: Private: my passport drawer is the blue one, My favourite colour is teal" (the older notes from dry runs).
2. Message actions, Remember on my own message: dialog "Remember this", Note pre-filled with the message, Kind "Work" selected, Remember button. Clicked Remember. Toast: "Remembered" with an "Open Knows" button (desktop-1, desktop-2).
3. The first time I could not click "Open Knows": the toast was gone by my next command (it lives a few seconds). I sent a second message "Desktop-A2: the kettle lives in the annex" in the same conversation (the fake echoed it properly, not empty), remembered that one and clicked "Open Knows" within the same command. It landed on `/agents/01M7VXDCXFWQ4EMJQSJPBNNZHH?tab=knows` (desktop-3).
4. Knows tab lists "Desktop-A2: the kettle lives in the annex" and "Desktop-A1: the printer room is on level 3" under "Work in progress", each with the source line "Saved from a conversation, 20 Nov" plus Edit and Forget. The link text is "a conversation" and it goes to `/threads/<session id>`. I clicked the A2 link and it opened `/threads/01M7VYBV6JR8F4SHQEDGWKDF5D`, the conversation the note came from.
5. New conversation with a different message (Desktop-A3). Reply: "I remember: Private: my passport drawer is the blue one / Desktop-A2: the kettle lives in the annex / Desktop-A1: the printer room is on level 3 / My favourite colour is teal" (desktop-4). The notes reach the run input. The fake only repeats them, so this proves delivery, not understanding.
6. sqlite3: `memory_changes` row for A1: kind work, status applied, written_by person, source_kind session, source_id = the thread id, user_scope empty. `library_entries` has `agents/mem-fake/memory/work.md` and `agents/mem-fake/memory/index.md`.
Result: PASS. This also covers the ME.6 log item "remember a message in a conversation and find it on Knows with its source link".

Phone
1. New conversation, "Phone-A1: the fax machine is in the cupboard". Reply echoed and listed the earlier notes (phone-1, phone-2).
2. Message actions, Remember: the dialog fits the screen (phone-3). Clicked Remember, then "Open Knows" in the toast (phone-4). It went to `?tab=knows` (scrollWidth 390).
3. Knows shows "Phone-A1: the fax machine is in the cupboard" with "Saved from a conversation, 20 Nov" (phone-5). Clicked the source link, it opened `/threads/01M7VZ2VN864Q1394K4R98F08F`.
4. New conversation "Phone-A2: anything to recall?": reply "I remember:" listed Phone-A1, Desktop-A2, Desktop-A1 and the older notes (phone-6).
5. sqlite3: row applied, person, session, source_id = the phone thread, no user_scope.
Result: PASS.

## B. Learn level ask_first (mem-cloud)

Desktop
1. mem-cloud Knows tab: "Ask me first" was already selected, nothing to change (desktop-5). Header showed "Needs you" with no badge; the drawer said "Nothing needs you. / 14 done today" (desktop-6).
2. New conversation: `call harbourmaster_remember {"kind":"work","text":"Desktop: the spare keys are in the blue tin"}`. After about 5 seconds: Done, one tool call "harbourmaster_remember", reply "tool said: Change 01M7VYJ0HP3374ZVRFBXK5HPX0 for note 01M7VYJ03E5RMYWGCN8MGSEZ8A held for approval." (desktop-7).
3. Without reloading, the header button became "Needs you, 1 waiting" with an orange 1 badge (desktop-7). The drawer showed one entry "mem-cloud wants to remember something" (desktop-8). Clicking it opened `/desk?item=01M7VYJ0HP3374ZVRFBXK5HPX0`.
4. The desk page says "mem-cloud wants to remember something / Held until you approve it. Approving adds it to what the agent knows." with Approve and Reject, and a "How it got here" fold-out ("mem-cloud started this Nov 20, 6:43 PM. Now: mem-cloud wants to remember something.") (desktop-9). It does not show the note text. See the surprising items.
5. Before approving I looked at the Knows tab: it shows the held note inline, "Wants to remember / Desktop: the spare keys are in the blue tin / Waiting for you / The agent" with Approve and Reject buttons (ME.6 item: yes, inline) (desktop-10).
6. Clicked Approve on the desk page. The page changed to `/desk` showing "Nothing needs you". The header badge disappeared (button back to "Needs you"). sqlite3: status applied, decided_by `user_3Kk8S5uJZvRLPGiEoZ8ZfJfCH8m`, decided_at 07:44:07Z, written_by agent, source_kind run (desktop-11).
7. Knows tab now lists "Desktop: the spare keys are in the blue tin / Noticed in a task, 20 Nov". The source link text is "a task" and goes to `/tasks/<run id>`, which redirected to `/threads/01M7VYHTYW08Z6SFVBF8GY2RTR`, the conversation (desktop-13). "Learned this week" lists "Remembered: Desktop: the spare keys are in the blue tin, today" with Undo (desktop-12).
8. Reject: new conversation with `call harbourmaster_remember {"kind":"work","text":"Desktop-reject: this one gets rejected"}`. Held, badge 1, drawer entry, desk page, clicked Reject. Went to `/desk`, badge gone. sqlite3: status rejected, decided_by set. The Knows notes list and Learned this week do not contain it (desktop-14).
Result: PASS.

Phone
1. New conversation `call harbourmaster_remember {"kind":"work","text":"Phone: the spare keys are in the red tin"}`: reply "tool said: Change 01M7VZ7AP1JS0EY9H9BD1RX0M0 ... held for approval." Header bell showed a badge 1 (phone-7). The page was not reloaded.
2. Drawer (full-width sheet): tabs "Mine 1 / Everyone 1", "Needs you 1", the entry "mem-cloud wants to remember something", then "24 done today" and a row "Working . 1 running" (phone-8). Text fits, no horizontal scroll (390). All runs were already `done` in the database, so "1 running" looked stale or transient.
3. Desk page at phone: heading wraps over three lines, the subtitle and body text wrap, Approve and Reject sit side by side, "How it got here" below (phone-9). No note text on this page either.
4. Knows tab at phone shows the held note inline with "Waiting for you" and Approve and Reject buttons, layout fine (phone-10).
5. Approve from the desk page: back to `/desk` "Nothing needs you", bell badge gone. sqlite3: applied, decided_by set. Knows lists the note and Learned this week lists "Remembered: Phone: the spare keys are in the red tin, today" (phone-11).
6. Reject: `Phone-reject: this one gets rejected` was held, the drawer entry opened the desk page, Reject went to `/desk`, badge gone, sqlite3 rejected, not in the Knows list (phone-12).
Result: PASS.

## C. Private note invisible to a second member (mem-fake)

The app has no switch for a private conversation (only Slack DMs make them). I made the conversation private with the single documented UPDATE.

Desktop
1. New conversation "Desktop-private: my locker code lives in the blue book", session `01M7VYPSPYXD8E8DHD8Y87B6FY`. Ran exactly one `update sessions set private=1 where id='01M7VYPSPYXD8E8DHD8Y87B6FY'`, reloaded the page, Message actions, Remember (Kind Work), toast "Remembered" (desktop-15, desktop-16).
2. sqlite3: `memory_changes` row "Desktop-private: my locker code lives in the blue book", applied, person, session, user_scope `user_3Kk8S5uJZvRLPGiEoZ8ZfJfCH8m`. `library_entries` has `agents/mem-fake/memory/private/user_3Kk8S5uJZvRLPGiEoZ8ZfJfCH8m.md` (379 B, later 554 B after the phone note).
3. Admin Library (`/library?dir=agents/mem-fake/memory`): lists index.md, private, work.md (desktop-17). The private folder lists the user file and it opens: content shows "# Private notes" with the passport note and the Desktop-private note, each with id, kind, date, source "session:...", by person, text (desktop-18).
4. Admin new conversation (Desktop-C2), reply "I remember:" starts with "Desktop-private: my locker code lives in the blue book", then "Private: my passport drawer is the blue one", then the shared notes (desktop-19). So Dev User gets the private note.
5. Member (Member Tester) Library, same folder: lists index.md, private, work.md (desktop-20). The private folder: "This folder is empty." (desktop-21). The direct URL for the file (`?dir=...private&file=...user_3Kk8S5uJZvRLPGiEoZ8ZfJfCH8m.md`): the panel shows "Not found" with a Close button (desktop-22). The tRPC `library.read` for that path returns 404 when fetched directly.
6. Member's Knows tab for mem-fake: lists only Desktop-A2, Desktop-A1 and "My favourite colour is teal". A text search of the page for "locker" and "passport" found 0 matches (desktop-23).
7. Member started a conversation on mem-fake ("Desktop-member: what do you know?"). Reply "I remember: Desktop-A2: the kettle lives in the annex / Desktop-A1: the printer room is on level 3 / My favourite colour is teal". No private note (desktop-24).
Result: PASS.

Phone (fresh marker "Phone-private: my safe is behind the clock")
1. Admin: new conversation, session `01M7VZA6ZKC726KNHBHNJBVVD7`, one UPDATE to private=1, reload, Remember. sqlite3: row applied with user_scope `user_3Kk8S5uJZvRLPGiEoZ8ZfJfCH8m`; the same private file grew to 554 B.
2. Admin Library at phone opens the folder and the private file; the file shows the three notes including "Phone-private: my safe is behind the clock" (phone-13, phone-14). Layout fits, 390.
3. Admin new conversation (Phone-C2): "I remember:" starts with "Phone-private: my safe is behind the clock, Desktop-private: ..., Private: ...".
4. Member at phone: private folder "This folder is empty." (phone-15); direct file path "Not found" (phone-16); Knows has no locker, passport or safe text (phone-17); a member conversation ("Phone-member: what do you know?") listed Phone-A1, Desktop-A2, Desktop-A1 and the colour note, none of the private ones (phone-18). scrollWidth 390.
Result: PASS.
Not tested: whether a workspace admin can see another person's private file (only Dev User's file existed).

## D. Real machine agent, library sync (mem-machine)

Desktop
1. Knows tab, Add note form: Kind "Work in progress", Note "Desktop: the loading dock code is 4471", Add note. List now shows it with "Added by hand, 20 Nov" (desktop-25). sqlite3: applied, person, source_kind empty.
2. Before the run the daemon copy had only people.md and index.md. New conversation "What is the loading dock code? Answer in one short sentence." Done after about 10 seconds. Reply: "The loading dock code is 4471, according to a note I saved on 2026-11-20." (desktop-26). The conversation shows a collapsed "Reasoning" block above the reply; the log has one thought about whether a code counts as a "password or key" under the memory rules, then it recalled the note.
3. Daemon folder `.../daemon/state/me9/work/01M7VXB2VX2P2ZDJPAPSYPE08F/01M7VXXDNA76JMVWXE3S23AAY7/work/library/agents/mem-machine/memory/` now holds index.md, people.md and work.md (work.md mtime 18:50:14, at run start). work.md contains "# Work", id 01M7VYXZBQ9W46QCTZDG8PJAEP, date 2026-11-20, source none, by person, text "Desktop: the loading dock code is 4471". index.md lists both notes. No `private/` folder or file anywhere under memory.
4. The Claude agent did not claim its memory folder was empty this time.
Result: PASS.

Phone
1. Added "Phone: the key safe code is 8832" (Work in progress) from the phone Knows tab (phone-19), asked "What is the key safe code? Answer in one short sentence." Reply: "The key safe code is 8832, according to my notes from 2026-11-20." (phone-20). Layout fine, 390.
2. Daemon work.md now has both the Desktop and Phone notes. No private files. No "memory folder empty" claim.
Result: PASS.

## E. Real cloud agent (mem-claude, Anthropic model)

Desktop
1. Knows tab: "Tell me after" was selected. Sent "Please remember that the meeting room is called Kestrel. Use your remember tool, then confirm in one sentence." Done in 6 seconds. Reply: "I've saved a note that the meeting room is called Kestrel, and it has been applied." One tool call harbourmaster_remember; the Files area showed two files edited outside the task folder (memory/index.md, memory/places.md) (desktop-27).
2. sqlite3: "The meeting room is called Kestrel.", kind places, applied, written_by agent, source_kind run, source_id = that run.
3. New conversation "What is the meeting room called? One sentence." Reply: "The meeting room is called Kestrel." (desktop-28). The note is used.
4. Knows tab lists it under "Where things are" with "Noticed in a task, 20 Nov", link "a task" to `/tasks/<run id>`.
5. Changed How it learns to "Ask me first" (radio checked, desktop-29). New conversation (my wording "Phone-less. Desktop: the courier is called Quill. Please remember that ... confirm in one sentence."). The agent saved it and said it "is held for approval rather than applied yet." Header showed "Needs you, 1 waiting". Drawer entry "mem-claude wants to remember something", desk page (desktop-30), Approve, back to `/desk`, badge gone. sqlite3: applied, decided_by set.
Result: PASS. The stored text is my sloppy wording "Phone-less. Desktop: the courier is called Quill.", not a bug.

Phone
1. Set the learn level back to "Tell me after" on the phone Knows tab (phone-21), asked it to remember "the loading bay is called Heron". Reply: "I've saved a note that the loading bay is called Heron, and it has been applied." sqlite3 applied at once, written_by agent, source_kind run, no decided_by.
2. New conversation "What is the loading bay called? One sentence." Reply "The loading bay is called Heron." Knows lists it (phone-22).
3. Set "Ask me first", asked it to remember "Phone: the courier is called Quill". It noticed my earlier conflicting note ("under 'Phone-less. Desktop', but your message says 'Phone'"), saved anyway, "held for approval". Bell showed 1, drawer entry, desk page (phone-23), Approve, `/desk`, badge gone. sqlite3: "Phone: the courier is called Quill." applied, decided_by set.
Result: PASS.

## Known finding recorded separately: empty echo for the scripted faux model
Reproduced at phone. In the held mem-cloud conversation I sent "hello again" as a second message (Ctrl+Enter). Task 2 of 2 finished and the reply was just "echo:" with nothing after it. In the fake runtime (mem-fake) second messages in the same conversation echoed correctly (A2).

## Console, network and server log

- Admin session: no page errors. Only Clerk's development-keys warning, a WebGL fallback warning, "No available adapters." (warning), and two `[error]`-level lines of the form "[Server] LOG http://localhost:3917/__tsd/open-source?source=%2Fsrc%2Fserver.ts%3A185%3A9". These come from the TanStack devtools console-pipe forwarding a server-side `console.error` ("tRPC desk.rail failed") into the browser console.
- Member session: `Failed to load resource: 404 (Not Found)`. Cleared the console and tested per page: Knows page 0, private folder 0, direct private-file URL 2 per load. A direct `fetch` of `/api/trpc/library.read` for the private file returns "404 Not Found". So these are the deliberate denial of the file, not a bug, but they are console errors and failed requests. The accumulated count in the session was 98, more than the loads I can account for one by one; I did not find another source.
- No Clerk 400 or 401 seen. No favicon requests counted.
- Dev server log (`dev.log`), new entries during my run: 6 lines "tRPC desk.rail failed: ... select ... from runs where ... status in (queued, offered, running, waiting)" all at 18:51:11 (07:51:11Z), while the mem-claude run of flow E was finishing and I was reading the database with the sqlite3 CLI. The log line gives no cause text. The earlier two desk.rail failures at 18:36 to 18:37 (before my session) carried "database is locked: SQLITE_BUSY" and "Failed to get session commit token". I cannot tell if my own sqlite3 reads caused the lock. The UI showed no visible problem at that moment. Everything else in the server log from my run is `mcp.request` lines with status 200 or 202.

## Surprising, not flow failures (one line each, with repro)

- The desk approval page for "wants to remember something" does not show the note text, so the person cannot tell what they are approving. Repro: hold a note (flow B), open `/desk?item=<id>`. The Knows tab does show the text inline.
- Needs you drawer entry shows the same sentence twice (title and the line under it, "mem-cloud wants to remember something"). Repro: open the drawer with a held note.
- The "Open Knows" toast lasts only a few seconds. Repro: Remember a message, wait about 5 seconds, it is gone.
- Phone: the toast sits over the composer buttons (phone-4).
- Phone: the floating round dev badge (devtools trigger, bottom right) covers the Send button; `click` on Send failed with "blocked by another element". Ctrl+Enter works. Repro: open any thread at 390 wide. Dev-only, probably.
- Phone: drawer showed "Working . 1 running" while every run in the database was `done` (phone-8). Repro: open the drawer right after a cloud run ends.
- Hand-added and agent notes read the same in Knows except the source line ("Added by hand", "Noticed in a task", "Saved from a conversation"). Private notes of Dev User appear in the admin's Knows list with no private marker (e.g. "Private: my passport drawer is the blue one" next to shared notes). Repro: Knows tab of mem-fake as Dev User.
- The Member Tester sees Edit and Forget buttons on mem-fake notes while the Remember rules block says "Only the owner or an admin can change these." I did not click them. Repro: member opens mem-fake Knows.
- Member Library lists the folder name "private" (empty). The file itself is not listed or readable.
- Library breadcrumb leaves out the last level (folder `memory` shows "Library / agents / mem-fake", folder `private` shows up to `memory`). Repro: open `/library?dir=agents/mem-fake/memory`.
- `agent-login` default redirect is `http://localhost:3000`, so without `--base-url http://localhost:3917` the one-time URL lands on a dead port.
- The mem-claude agent reported conflicting notes honestly (my own sloppy wording); not a defect.
- `networkidle` never completes on any app page (25 s timeout). Repro: `agent-browser wait --load networkidle`.
- My A3 message accidentally contained "--name What should it do?" (a CLI mistake of mine), which is why one conversation has that title.

## Verdict

FAIL under the stated strict rule (any console error or failed request fails it). All ten flow and size cells worked as intended, but I saw: (1) browser console 404 errors and failed `library.read` requests on the member's direct private-file URL (expected denial, not an app bug); (2) two `[error]`-level console lines forwarding server-side "tRPC desk.rail failed" messages, and six `desk.rail` failures in the dev server log at 18:51:11 whose cause is not shown and may be local SQLite lock contention. If the 404 probe is counted as intended and the desk.rail failures are treated as a dev-database artefact, the flows themselves are PASS.

## Screenshot index

Desktop (1280x800): 1 Remember dialog on my own message (mem-fake, Kind Work). 2 toast "Remembered / Open Knows" over the conversation with the Echo and "I remember:" reply. 3 mem-fake Knows tab after Open Knows (A1, A2 notes). 4 new conversation reply (Desktop-A3) listing notes under "I remember:". 5 mem-cloud Knows, "Ask me first" checked. 6 Needs you drawer empty (baseline). 7 mem-cloud conversation Done with "held for approval" and badge 1. 8 Needs you drawer with the entry. 9 desk item page (no note text). 10 mem-cloud Knows with the held note and inline Approve and Reject. 11 desk after Approve ("Nothing needs you"). 12 Knows scrolled down, "Learned this week" with the approved note. 13 conversation opened from the "a task" source link. 14 Knows after Reject (rejected note absent). 15 Remember dialog on the private conversation. 16 toast after Remember on the private conversation. 17 admin Library, folder memory. 18 admin Library, private file open. 19 admin conversation reply including the private note. 20 member Library, folder memory. 21 member Library, private folder empty. 22 member direct private file URL, "Not found". 23 member Knows tab of mem-fake (no private note). 24 member conversation reply (no private note). 25 mem-machine Knows after the hand-added note. 26 mem-machine reply "4471". 27 mem-claude Kestrel run with the remember tool call. 28 mem-claude answer "Kestrel". 29 mem-claude Knows with "Ask me first" selected. 30 desk item for the mem-claude Quill note.

Phone (390x844): 1 mem-fake agent page. 2 New conversation dialog. 3 Remember dialog. 4 toast with Open Knows over the composer. 5 Knows tab with Phone-A1. 6 reply to Phone-A2 listing notes. 7 mem-cloud conversation, held, bell badge 1. 8 Needs you drawer. 9 desk item page. 10 Knows with inline Approve and Reject. 11 desk after Approve. 12 Knows after the phone Reject. 13 admin Library folder memory. 14 admin private file open. 15 member private folder empty. 16 member direct file path "Not found". 17 member Knows (no private note). 18 member conversation reply (no private note). 19 mem-machine Knows after the phone note. 20 mem-machine reply "8832". 21 mem-claude Knows "Tell me after" selected. 22 mem-claude Knows after the Heron note. 23 desk item for the mem-claude Quill note. 24 mem-cloud second message, reply "echo:" (faux finding).
