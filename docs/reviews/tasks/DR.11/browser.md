# DR.11 browser verification

Verdict: PASS. All seven flows work at 1280x800 and 390x844, with no console errors or failed requests in the final clean pass, and no horizontal scroll (documentElement scrollWidth equals clientWidth at both sizes in every screenshot).

Setup: worktree `/home/roboto/devel/harbourmaster-wt/DR.11`, `vite dev --port 3951`, local D1 migrated, agent `fake-echo` from `scripts/dev/seed-fake-agent.ts`, signed in through `/api/dev-login`, browser session `dr11-verify`. Dream rows were seeded straight into local D1 with a scratch script (outside the repo, `/home/roboto/devel/harbourmaster-wt/tmp/DR.11/seed-state.ts`): `dream_runs`, `memory_changes` (status held, action add) and `dream_questions`, with diaries in the `writeDiary` format. `base_version` is set to the latest library version of the agent's memory files, as a real dream records it.

Real through the UI, not seeded as end state: Approve, Reject, Undo this night, and answering the question in Needs you ("Keep this one"). Approve and Undo wrote real library versions. Only the starting rows (held batch, open question) were seeded. Nothing needed an end-state seed.

## Flows (card text is the dream card's innerText; same wording at both sizes)

1. Held, Approve/Reject. `desktop-1.png`, `phone-1.png`. Card reads "These changes wait for your approval. Wants to add 3 notes." with three "Would add:" lines, "These changes are held...", Approve and Reject buttons. Held wording kept.
2. After Approve (real click). `desktop-2.png`, `phone-2.png`. "Added 3 notes." / three "Added: ..." lines / "You approved these changes." No "wait for your approval", no "Wants to", no "Would add". Undo this night and See changes shown.
3. After Reject (real click). `desktop-3.png`, `phone-3.png`. "Wanted to add 3 notes." / three "Would add:" lines kept / "You rejected these changes. Nothing was changed." No "wait for your approval". See changes only.
4. Open question. `desktop-4.png`, `phone-4.png`. "Asked: Which is right: ...", "Nothing changed.", "One question is waiting for you. Open Needs you" (link goes to /desk). Needs you badge shows 1.
5. Question answered in Needs you (real "Keep this one" click, desktop `/desk?item=...`, phone via the list then the item). `desktop-5.png`, `phone-5.png`. Card now says "You answered the question." No link, no "waiting for you" anywhere in the card. Badge gone.
6. Undo this night (real click after a real approve). `desktop-6.png`, `phone-6.png`. "You undid this night. The notes are back as they were." then the diary with "You approved these changes." and "You undid this dream." No Undo button.
   Variant with a question (held with an open question, then Approve, then Undo): `desktop-6b-held.png`, `desktop-6b-approved.png`, `desktop-6b.png` and the `phone-` equivalents. Held shows "One question is waiting for you. Open Needs you" next to the held wording. After approve it reads "Added 3 notes ... You approved these changes." plus "One question is waiting for you." with the link (the question is still open). After Undo the card has no "waiting for you" text and no link, and the question is closed.
7. Earlier dreams, rejected entry. `desktop-7.png`, `phone-7.png`. Entry "Rejected": "Wanted to add 3 notes. Would add: ... You rejected these changes. Nothing was changed." Approved entry reads "Added 2 notes." No held sentence on any entry.

## Console and network

Final clean pass (console and errors cleared first): desktop flows 1-7 and 6b, plus the phone pass, produced no console errors or warnings other than Clerk's development-keys warning and the React DevTools info. The dev-login 400 and favicon 404 did not appear in this log. The vite log shows no new server error during the clean passes.

An earlier desktop pass logged one 409 and one 500. Both came from my seeding, not from DR.11:
- 409: my first seed left `base_version` as `[]`, so Approve correctly refused with "Memory changed since this dream ran" (the service's staleness check). Fixed the seed.
- 500: a `desk.rail` read hit `SQLITE_BUSY` while my seed script held a write on the local D1 file (vite log lines 106-124). Out-of-band seeding artifact. It did not recur in the clean passes.

## Observations (not failures)
- A question-only dream shows "Nothing changed." between the "Asked:" line and the question line. It is true (no notes changed) and was there before.
- An "Undone" entry in Earlier dreams shows only the badge and See changes, no diary text.
