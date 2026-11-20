Verdict: pass

Caveats first. The feature worked in every flow at both sizes. The console and network logs hold a few errors, all caused by my own seeding and probing, none by the app: one 400 (malformed seed id), one 409 (I undid a note that had been edited since), and three 500s from SQLITE_BUSY while my `sqlite3` seed writes ran next to page loads. Details under "Console and network". If the dispatcher counts those against the "no failed requests" rule, read this as a fail on tooling noise only.

Build under test: branch task/ME.17-only-owners-change-notes, head af2643e4. Real headless Chromium through agent-browser, dev server from the worktree on port 5417 (PUBLIC_BASE_URL set to match), local D1 migrated first. Four sessions, each with its own profile: me17-admin-d and me17-admin-p (dev admin, "Dev login (local only)", user Dev User, org admin) and me17-member-d and me17-member-p (the existing dev+member@harbouredgeintelligence.ai, "Member Tester", through `bun run agent-login`). Desktop 1280x800, phone 390x844. No Clerk users were added. No source file was touched.

## Seed
All through the signed-in browser sessions' own tRPC calls, except the held rows.
- As the admin: `agents.create` (fake runtime, "Notes Owner Test", id 01M7WFHAF4222YX1BPYF1WSASC, created by the admin), `agents.setOwners` (owner = the admin), `memory.rules.set` (learn level "Tell me after", dreams off), then 12 shared notes with `memory.add` (people, places, work, corrections). Each shows as an applied change under "Learned this week".
- Held shared agent changes: no UI route gives a plain member or admin a held agent note without a runtime that calls the memory tool, so I inserted `memory_changes` rows (status held, written_by agent, action add, no dream run, no user scope) straight into the local D1 file with `sqlite3`. Three batches, 8 + 8 rows. The first batch had note ids that were not valid ULIDs (see console section); I deleted it and reseeded with valid ids.
- Private note: as the member, `runs.start` with `session.private: true` made a private conversation, then `memory.add` with `source: {kind: "session", id}` wrote four private notes (userScope = the member's id).
- Role switch for F4: the admin called `agents.setOwners` to make the member the owner, then back to the admin before F5.

## F1 Plain member, someone else's agent (pass, both sizes)
Steps: open the agent page (the first tab, labelled "Chat", holds the "Learned this week" card), then the Knows tab. Counted buttons with an `innerText` audit and checked each Undo row by its text.
- Desktop (desktop-1 agent page, desktop-2 Knows tab): shared notes show no Edit or Forget. Held agent notes show the text, "Waiting for you" and "The agent", with no Approve or Reject. "Learned this week" rows for shared notes have no Undo. The only Edit, Forget and Undo buttons belong to the member's own private notes (marked "Private") and their private changes. The line "Only the agent's owners and admins can change its notes." shows under the notes list and under "Learned this week". "Remember rules" says "Only the owner or an admin can change these." and its controls are disabled. The Now card on the agent page has the same line and Undo only on private rows. No horizontal overflow (scrollWidth 1280).
- Phone (phone-1 agent page, phone-2 Knows tab): same result, scrollWidth 390.
- Small wording note, not a failure: a non-owner sees held agent notes labelled "Waiting for you", which reads as if the member must act. Cosmetic and outside the task's scope.

## F2 Member's own private note, and adding a note (pass, both sizes)
- Desktop: Edit on a private note, text changed, Save, row updated (desktop-3). Forget on another private note, confirm dialog, row gone, "Forgot: ..." appeared under Learned this week (desktop-4). Add note with "Member added shared note desktop" in the Note box: it was added and shows under Learned this week (desktop-5). The member's own shared note has no Edit, Forget or Undo, which matches the rule.
- Phone: same sequence (phone-3 edit, phone-4 forget, phone-5 add), all worked.
- Every Undo on the member's page, at both sizes, belongs to a private change.

## F3 Dev admin, who is also the owner (pass, both sizes)
Knows tab: Edit, Forget, Approve, Reject and Dream now show everywhere, Undo shows on every Learned row, and the member-only line is absent (desktop-6, phone-6). The agent page's Learned card has Undo too (desktop-12, phone-19). Each action ran at both sizes on a fresh row and was checked in the D1 file:
- Edit of a shared note: text changed (desktop-7, phone-7).
- Forget of a shared note, with confirm: forgotten (desktop-8, phone-8).
- Undo on a "Remembered: ..." row: change status became undone (desktop-9, phone-9).
- Approve of a held note: held to applied (desktop-10, phone-10).
- Reject of a held note: held to rejected (desktop-11, phone-11).

## F4 Member made the agent's owner (pass, both sizes)
The admin set the member as owner (the header read "Owner: Member Tester"). As that non-admin owner:
- The Knows tab shows Edit, Forget, Approve, Reject, Dream now and Undo on shared notes and shared held notes, and no member-only line (desktop-13, phone-12).
- Desktop: Edit of a shared note (desktop-14), Forget (desktop-15), Undo (desktop-16), Approve (desktop-17), Reject (desktop-18), each confirmed in D1.
- Phone: Edit (phone-13), Forget (phone-14), Undo (phone-15), Approve (phone-16), Reject (phone-17), each confirmed in D1.
- Extra: with the member as owner, the admin is no longer an owner but still an org admin. The admin's Knows tab kept all controls, and Approve and Undo worked (desktop-19).

## F5 Server refusal, member as non-owner (pass, both sizes)
Ownership was set back to the admin first. As the member, from the browser, with the same wire format as the app client (`POST /api/trpc/<proc>?batch=1`, body `{"0": input}`, no transformer), against a shared note, an applied shared change and a held shared change:
- memory.edit: 403 FORBIDDEN "Not allowed: memory.write"
- memory.forget: 403 FORBIDDEN
- memory.undo: 403 FORBIDDEN
- memory.decide approve: 403 FORBIDDEN
- memory.decide reject: 403 FORBIDDEN
After the five calls the shared notes' text and every change's status were byte-for-byte identical to before (`unchanged: true`) at both sizes. Screenshots of the Knows tab afterwards: desktop-20, phone-18. The two probe runs (one per size) account for ten 403 lines in the console.

## Console and network
`agent-browser network requests` was not used for evidence; I read each session's console log, which records every failed resource, and the dev server log.
- Clerk development-keys warning, WebGL fallback warning, React devtools info on every session. No page errors or uncaught exceptions.
- 403 x5 per member session: the labelled F5 probes. Expected.
- 400 x1 (admin-d): my first Approve hit a held row whose note id was not a valid ULID (my seed used "NOTE..." with an O). The page showed "people.md:21: Expected a 26 character ULID" and nothing was written. I replaced the seed rows and Approve then worked. Seed fault, not an app fault.
- 409 x1 (member-p, F4 phone): I clicked Undo on the add of a note that the member had already edited, and the service refused with "The note changed after this change". Correct behaviour for a bad choice of mine; I redid Undo on a fresh row and it worked.
- 500 x3 (admin-d once, admin-p twice): `desk.rail`, `artifacts.pins` and `tasks.list` failed with SQLITE_BUSY ("database is locked") in dev.log, at moments when my out-of-band `sqlite3` seed writes into the same local D1 file overlapped a page load. These are shell requests unrelated to memory. No memory call failed this way.
- favicon.ico 404: not checked, out of scope.

## Observations, not failures
- The Now card is on the agent page's first tab, which the UI labels "Chat".
- A member's own shared note (added through Add note) has no Edit, Forget or Undo for the member. That follows the rule: shared notes are the agent's.
- Local runs: dev server and its child processes were stopped by the PID I started (2001227 and its descendants). Port 5417 is free. Scratch files are in /home/roboto/devel/harbourmaster-wt/tmp/ME.17/.

## Screenshots
desktop-1 to desktop-20 and phone-1 to phone-19 in this folder; the numbers are cited in each flow above.
