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

## Round 2

Independent re-verification by a second verifier, 2026-11-20 about 19:06 to 19:17 AEDT. No source edits, no git commands, dev server and daemon untouched, no Clerk users created. Scope: the fix to the Needs you item page for a held memory note, plus a strict console, network and server-log pass on the memory flows.

### What ran and how

- Same dev server (http://localhost:3917, ME.9 worktree) and the same `agent-browser` headless Chromium. Sessions `me9-verify2` (admin, Dev User, `/api/dev-login`) and `me9-member2` (Member Tester, `agent-login` with `--base-url http://localhost:3917`). Desktop 1280x800, then phone 390x844 with a fresh `open` after the resize. `document.documentElement.scrollWidth` was 1280 on desktop and 390 on every phone page I read (agent page, Knows, desk item, thread, Library folder, file, member pages).
- Agents: mem-fake (fake runtime) and mem-cloud (cloud, scripted `faux` model, learn level "Ask me first", confirmed on its Knows tab as the checked radio).
- Console and network: `agent-browser console` per session, cleared before each flow so every line is attributable. Chromium prints every 4xx/5xx fetch as a console error, so that is the failed-request detector. `agent-browser network requests` lists URLs without status, so for the one console 400 I reproduced the sign-in in a scratch Playwright script (outside the repo, read-only against the app) that logs response statuses. Server side: `dev.log` lines 509 to 600 (everything written during this round).
- sqlite3: used twice in total, both times after I had navigated both browsers to about:blank so nothing was polling (19:17:26, one query on `memory_changes`, one count of held rows). No other database reads.
- Baseline note: the Needs you badge already showed "1 waiting" when I started. It is a leftover held note from the fixer's own check ("Fix check: the post box is by the lift", item 01M7VZTMP1K1DDSFW69RC9NRAE, created 19:05, before my first command). I did not decide it. "Badge gone" below therefore means the count went back to the baseline of 1, and the drawer showed only that leftover. This is why, after each Approve or Reject, the page moved on to `/desk?item=01M7VZTMP1K1DDSFW69RC9NRAE` instead of `/desk` (round 1 landed on `/desk` because nothing else was waiting). That advance-to-next-item behaviour is fine and consistent.
- Markers: "R2-Desktop" and "R2-Phone".

### Results table

| Flow | Desktop | Phone |
|---|---|---|
| B2 mem-cloud held note, approve and reject from the item page | PASS | PASS |
| A2 mem-fake Remember from message menu, Knows, new conversation | PASS | PASS |
| C2 member through the UI only | PASS | PASS |

### B2. mem-cloud, held note, item page shows the text (the fix)

Desktop
1. New conversation on mem-cloud: `call harbourmaster_remember {"kind":"work","text":"R2-Desktop the loading ramp key is under the mat"}`. Done after about 8 seconds. Page showed "harbourmaster_remember, 1 tool call" and "tool said: Change 01M7VZYRC857W9MJ18DMET8HGA for note 01M7VZYQXWHAFCDNJ60DT4HF1F held for approval." Badge went from 1 to 2 without a reload.
2. Needs you drawer: tabs "Mine 2 / Everyone 2", two rows, both reading "mem-cloud wants to remember something" (the title is still shown twice per row, with an "M" avatar between, as in round 1). One row was the leftover, one mine (item 01M7VZYRC857W9MJ18DMET8HGA, found from the row hrefs because both rows read the same). Footer "35 done today" (desktop-31).
3. Clicked my row. URL `/desk?item=01M7VZYRC857W9MJ18DMET8HGA`. The page shows, in order: heading "mem-cloud wants to remember something", "mem-cloud", then the note text in bold, exactly "R2-Desktop the loading ramp key is under the mat", then "Held until you approve it. Approving adds it to what the agent knows.", then Approve and Reject buttons, then a "How it got here" fold-out ("mem-cloud started this Nov 20, 7:07 PM. Now: mem-cloud wants to remember something."). The note text is visible together with Approve and Reject. The round 1 finding is fixed (desktop-32).
4. Approve. Badge went from 2 to 1 (the leftover) and the page advanced to the leftover item, which also shows its own text, "Fix check: the post box is by the lift" (desktop-33). Knows tab of mem-cloud (`?tab=knows`): "R2-Desktop the loading ramp key is under the mat / Noticed in a task, 20 Nov" with Edit and Forget; "Learned this week" first row "Remembered: R2-Desktop the loading ramp key is under the mat, today" with Undo (desktop-34, desktop-35). sqlite3: applied, written_by agent, source_kind run, decided_by set.
5. Second held note `call harbourmaster_remember {"kind":"work","text":"R2-Desktop reject me"}`, held, badge 2, drawer row, item page showed "R2-Desktop reject me" with Approve and Reject (desktop-36). Reject. Badge back to 1, page advanced to the leftover. Knows notes list and Learned this week do not contain it: a text count for "reject me" on the Knows page was 0 (desktop-37). sqlite3: rejected, decided_by set.

Phone
1. Conversation `call harbourmaster_remember {"kind":"work","text":"R2-Phone the dock gate code is under the pot"}`, held, bell badge 1 to 2 (phone-25). Drawer is a full-width sheet with the same two rows (phone-26). Clicked mine (`/desk?item=01M7W087KXEHX0Z3YMEFE4MCKA`).
2. Item page at 390 wide: heading wraps over three lines, then "mem-cloud", then "R2-Phone the dock gate code is under the pot" (bold), the "Held until you approve it..." line wrapping to two lines, Approve (x 16 to 86) and Reject (x 94 to 152) side by side on one row at y 305 to 333, fully inside the viewport and not covered by anything but the floating dev badge in the bottom right corner, which sits well below them. scrollWidth 390 (phone-27).
3. Approve: badge 2 to 1, advanced to the leftover item (phone-28). Knows lists "R2-Phone the dock gate code is under the pot" and Learned this week has "Remembered: R2-Phone the dock gate code is under the pot, today"; scrollWidth 390 (phone-29, phone-30).
4. "R2-Phone reject me": held, drawer row, item page showed the text (phone-31), Reject, badge back to 1, text count on Knows 0 (phone-32). sqlite3: rejected, decided_by set.
Result: PASS at both sizes.

### A2. mem-fake, Remember from the message menu

Desktop
1. New conversation, sent "R2-Desktop the bike shed is out back". Reply "Echo: R2-Desktop the bike shed is out back / I remember: ..." listing the older notes.
2. Message actions menu, Remember (menu has one item "Remember"). Dialog: Note pre-filled with the message, Kind combobox with People, Corrections, Work (selected), Places, buttons Remember, Cancel, Close (desktop-38). Clicked Remember. Toast text: "Remembered" and an "Open Knows" button (desktop-39).
3. Clicked Open Knows in the same command: `/agents/01M7VXDCXFWQ4EMJQSJPBNNZHH?tab=knows`. Knows lists "R2-Desktop the bike shed is out back / Saved from a conversation, 20 Nov" with Edit and Forget. The "a conversation" link for it goes to `/threads/01M7W0454EBBRG74DRZDKXZJVA`, the thread I sent the message in (desktop-40).
4. NEW conversation "R2-Desktop what do you know?" Reply: "Echo: R2-Desktop what do you know? / I remember: Phone-private..., Desktop-private..., Private..., R2-Desktop the bike shed is out back, Phone-A1..., Desktop-A2..., Desktop-A1..., My favourite colour is teal". The new note is under "I remember:" (desktop-41). sqlite3: applied, written_by person, source_kind session, decided_by empty.

Phone
1. Same steps with "R2-Phone the bike shed key is on the hook": Remember dialog fits the screen (phone-33, phone-34), toast "Remembered / Open Knows" over the page (phone-35), Open Knows landed on `?tab=knows`, scrollWidth 390, note listed with "Saved from a conversation, 20 Nov", source link `/threads/01M7W0CFQKG2JYES7P8P3297P9` (the sending thread) (phone-36).
2. New conversation "R2-Phone what do you know?": "I remember:" lists R2-Phone the bike shed key is on the hook and R2-Desktop the bike shed is out back among the others (phone-37). sqlite3: applied, person, session.
Result: PASS at both sizes.

### C2. Member, UI only (Member Tester, session me9-member2)

Desktop
1. Header Files link goes to `/library`, which lists the folder "agents". Browsing agents, then mem-fake lists "memory" and "tasks". The `memory` folder lists index.md (374 B), private (folder) and work.md (797 B) (desktop-42).
2. work.md opens and shows "# Work" and five entries: My favourite colour is teal, Desktop-A1, Desktop-A2, Phone-A1 and R2-Desktop the bike shed is out back. A text count for "locker", "passport" and "safe is behind" is 0. index.md shows the same notes by id and none of the private ones (desktop-43).
3. The `private` folder: "This folder is empty." The member cannot see or open the private file by browsing (desktop-44).
4. mem-fake Knows tab as the member lists only R2-Desktop the bike shed is out back, Phone-A1, Desktop-A2, Desktop-A1, My favourite colour is teal. Counts on the page: "passport" 0, "locker" 0, "safe is behind" 0, "Private:" 0, "Desktop-private" 0, "Phone-private" 0 (desktop-45).
5. EXPECTED-DENIAL PROBE (one only, desktop): direct URL `/library?dir=agents%2Fmem-fake%2Fmemory%2Fprivate&file=agents%2Fmem-fake%2Fmemory%2Fprivate%2Fuser_<Dev User id>.md`. Page shows the empty private folder and a panel "Not found" with Close. Console: exactly one "Failed to load resource: the server responded with a status of 404 (Not Found)" (round 1 counted two per load). Same denial as before (desktop-46).

Phone
1. Reached Library through Menu then Files. Same walk: agents, mem-fake, memory lists index.md (446 B), private, work.md (958 B) (phone-38). work.md opens and shows R2-Phone the bike shed key is on the hook, no private text (count 0), scrollWidth 390 (phone-39). private: "This folder is empty." (phone-40). Knows: same six zero counts as desktop, shows the R2-Phone and R2-Desktop notes and their Learned this week rows (phone-41).
2. EXPECTED-DENIAL PROBE (one only, phone): the same direct URL, "Not found" panel, one 404 console line (phone-42).
Result: PASS at both sizes. The member cannot see or open a private file and does not see the private notes on Knows.

### Console, network and server log (strict pass)

Per session, per size. Warnings I ignored as not errors: Clerk "development keys" warning on every load. No "[error]" lines forwarding server console output (the "[Server] LOG ... __tsd/open-source" kind seen in round 1) appeared in the error level this round; the `[log]`-level "[Server]" lines I saw were `mcp.request` records with status 200 or 202 only.

| Session and phase | Console errors | Failed requests |
|---|---|---|
| Admin, desktop, B2 (from first sign-in) | 1: "Failed to load resource: the server responded with a status of 400 ()", seen once, right after the first `/api/dev-login`, before any memory page | see below |
| Admin, desktop, A2 | 0 | 0 |
| Admin, phone, B2 | 0 | 0 |
| Admin, phone, A2 | 0 | 0 |
| Member, desktop, C2 browsing | 0 | 0 |
| Member, desktop, expected-denial probe | 1 x 404 (the labelled probe) | 1 x 404 (the probe) |
| Member, phone, C2 browsing | 0 | 0 |
| Member, phone, expected-denial probe | 1 x 404 (the labelled probe) | 1 x 404 (the probe) |

The 400: I traced it. It is the Clerk call `POST https://<dev instance>.clerk.accounts.dev/v1/client/sign_ins` made by `/dev-login` when the browser already holds a signed-in session. I reproduced it in a scratch Playwright run: first `/api/dev-login` in a clean context gave no 4xx at all; a second `/api/dev-login` in the same context gave exactly this one 400 and the same console line, and still landed on `/home`. I did the same re-login once more in `me9-verify2` (at about 19:09, console cleared first) and got the same single 400. For the very first sign-in of `me9-verify2` at 19:06 I cannot say whether the session profile was already signed in, so I cannot tell if it was this same cause; I did not record the member sign-in console (it happened before I started capturing). It is not a request made by any memory page: nothing with a 4xx came from `/agents`, `/desk`, `/threads` or `/library` in any of the memory flows at either size. It does not correlate with sqlite3 (no sqlite3 call had been made yet).

Server log (`dev.log`, lines 509 to 600, 19:06 to 19:17): 12 `mcp.request` lines with status 200 and 4 with status 202 (initialize, notifications/initialized, tools/list, tools/call "remember"), plus Clerk development-keys client warnings. Zero lines matching tRPC, failed, SQLITE or locked. In particular there were no "tRPC desk.rail failed" lines this round. I called sqlite3 only at 19:17:26 with the browsers parked on about:blank; nothing was written to the log after that. The round 1 `desk.rail` failures remain at older lines (370 to 372), outside this round, so I have no new evidence on whether my sqlite3 reads caused those. This round both the log and the sqlite3 use were clean, which is consistent with the lock theory but does not prove it.

### Other observations (not failures)

- Needs you drawer row still shows "mem-cloud wants to remember something" twice, with an "M" between. Same as round 1.
- Member Library shows Rename, Move and Delete buttons on mem-fake folders and files, and on work.md Save, Download, Delete and history Restore buttons. I did not click any of them. Same class as the round 1 Edit and Forget finding on Knows.
- The leftover held note ("Fix check: the post box is by the lift", mem-cloud) was still held at the end (1 held row in `memory_changes`). It belongs to the fixer, not this round.
- Round 2 test data left behind: applied notes "R2-Desktop the loading ramp key is under the mat", "R2-Desktop the bike shed is out back", "R2-Phone the dock gate code is under the pot", "R2-Phone the bike shed key is on the hook"; rejected "R2-Desktop reject me", "R2-Phone reject me".

### Verdict (round 2)

FAIL under the literal strict rule, for one reason only: the admin session logged one console "Failed to load resource ... 400" from the Clerk sign-in call that `/api/dev-login` makes when the browser is already signed in. All three flows (B2, A2, C2) worked at both desktop and phone size, the item-page fix is confirmed (the note text is shown together with Approve and Reject at both sizes, nothing overflows, scrollWidth 390), the only other console errors were the two labelled expected-denial 404s, and the server log and network were otherwise clean with no tRPC or SQLite errors. If the dev-login sign-in 400 is accepted as outside the memory flows, this round is a PASS.

### Round 2 screenshot index

Desktop (1280x800): 31 Needs you drawer with two rows (leftover plus mine). 32 item page for "R2-Desktop the loading ramp key is under the mat" with Approve and Reject. 33 page after Approve (advanced to the leftover item). 34 mem-cloud Knows with the approved note. 35 Knows scrolled to Learned this week. 36 item page for "R2-Desktop reject me". 37 Knows after Reject (note absent). 38 mem-fake Remember dialog. 39 toast "Remembered / Open Knows". 40 mem-fake Knows with the R2-Desktop note and source link. 41 new conversation reply listing the note under "I remember:". 42 member Library, memory folder. 43 member work.md open. 44 member private folder empty. 45 member mem-fake Knows. 46 expected-denial probe, "Not found".

Phone (390x844): 25 mem-cloud conversation held, bell badge 2. 26 Needs you drawer with two rows. 27 item page for "R2-Phone the dock gate code is under the pot". 28 page after Approve. 29 Knows with the approved note. 30 Knows scrolled to Learned this week. 31 item page for "R2-Phone reject me". 32 Knows after Reject. 33 message actions menu on mem-fake. 34 Remember dialog. 35 toast "Remembered / Open Knows". 36 Knows with the R2-Phone note and source link. 37 new conversation reply listing the note. 38 member Library, memory folder. 39 member work.md open. 40 member private folder empty. 41 member mem-fake Knows. 42 expected-denial probe, "Not found".
