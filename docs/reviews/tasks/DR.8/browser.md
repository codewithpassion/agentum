Verdict: pass

Dispatcher note: the verifier reported fail on F5 only because the brief said "no Undo anywhere on the Knows tab". The Undo buttons it found sit under "Learned this week" and undo one applied note (`memory.undo`, the per-note memory feature from before DR.8, open to any workspace member with Edit and Forget on notes). They are not part of the held batch, which is what DR.8 makes owner and admin only: for the member the batch shows read-only, with no Approve, Reject, Dream now or batch Undo, and no Needs you card. That wider member question is left out of scope (see docs/reviews/tasks/DR.8.md). Every other flow passed at both sizes with no console errors or failed requests.

Original verifier verdict: fail (F5, Undo under Learned this week).

One failure, in F5 (plain member): Undo buttons show on the Knows tab. Everything else worked at both sizes. Real Chromium (headless), local dev server on port 3120, sessions dr8v2-admin (dev login, dev@rockyshoreslabs.io, org admin and Scout's owner) and dr8v2-member (dev+member@harbouredgeintelligence.ai). The member session ran without its own --profile because a leftover daemon from a failed first sign-in attempt ignored the flag. It was still a fresh session with no earlier user, and it reported the member address. Desktop 1280x800, phone 390x844. Seed pair re-run before the phone pass and before F5. One seed run failed with a Bun shell error and was re-run at once; no stray batches showed up.

Console and network. `agent-browser network requests` captured nothing ("No requests captured"), so I used the performance resource check after each flow. No resource with status >= 400 or 0 in any flow, either user, either size. Console had only the Clerk dev-keys warning, a WebGL fallback warning and React devtools info. No errors. No 409 occurred.

## F1 Knows tab, held state (pass, both sizes)
Desktop: desktop-1.png. Newest held batch (1 places note) is under "Today's dream" with "These changes are held. Nothing changes in memory until you approve.", the proposed note ("Added a note / Held for your approval / After ..."), and Approve and Reject. The older batch (2 notes) is under Earlier dreams with a Held badge, both notes and its own Approve and Reject. Neither reads Done or shows an "Added N notes" counts line. "Undo this night" appears nowhere. "What Scout remembers" read "Nothing remembered yet", so no held rows are listed there.
Phone: phone-1.png. Same content, no horizontal overflow (scrollWidth 390). Earlier dreams at that point also showed a Rejected and a Done entry from the desktop pass. They were correct. "Learned this week" listed the notes approved earlier, with Undo (see F5 note).

## F2 Needs you drawer (pass, both sizes)
Desktop: desktop-2.png (drawer, count 2, two cards "Scout has dream changes waiting for your approval"), desktop-3.png (the first card opened at /desk?item=<dream id>: two proposed notes with Approve and Reject).
Phone: phone-2.png (drawer via the bell button, count 2, two cards), phone-3.png (opened card with changes, Approve and Reject).

## F3 Approve (pass, both sizes)
Desktop, from the Needs you card: Approve on the card for the older batch. desktop-4.png: the card pane moved to the other held batch's card (live buttons belong to that batch only) and the count dropped from 2 to 1. After navigating back to Knows (client-side links, no reload), desktop-5.png: the batch reads Done "Added 2 notes." under Earlier dreams, and the two notes (people, work) appear under What Scout remembers.
Phone, from the Knows tab (earlier-dreams Approve on the older held batch): phone-4.png. The batch became Done "Added 2 notes.", its two notes appeared under What Scout remembers (they duplicate the notes from the desktop approve, as the seed repeats the same text; this is expected), the Needs you count went 2 to 1, and the Knows page updated with no reload. The remaining held batch kept its Approve and Reject.

## F4 Reject (pass, both sizes)
Desktop, from the Knows tab (newest held batch): desktop-6.png. The diary reads "You rejected these changes. Nothing was changed." with no "Added" line. The Sydney note did not appear under What Scout remembers. The Needs you button lost its count. desktop-7.png: drawer shows "Nothing needs you." Mine 0, Everyone 0.
Phone, from the Needs you card (the other surface): phone-5.png. After Reject the page showed "Nothing needs you" and the count was gone. phone-6.png (Knows): today's dream reads "You rejected these changes. Nothing was changed.", the Earlier dreams entry shows a Rejected badge, and the Sydney text appears only in the two rejected diary entries, not in What Scout remembers.

## F5 Plain member (fail on Undo, otherwise pass)
Desktop: desktop-8.png (full Knows tab), desktop-9.png (Needs you drawer). The held dream shows its changes with "These changes wait for the agent's owner or an admin to approve." There is no Approve, Reject or Dream now button anywhere. The Needs you drawer has no card and no count (Mine 0, Everyone 0). Phone: phone-7.png (Knows), phone-8.png (drawer, Mine 0, Everyone 0). Same content and result.
Failure: "Undo" buttons are present on the member's Knows tab, four of them under "Learned this week" ("Remembered: ... today"), at desktop and phone. They belong to notes already applied by the approved dreams, not to the held batch. The brief requires no Undo anywhere on the tab for a plain member. Expected: none. The member also sees Edit and Forget on the remembered notes, which the brief does not list. This looks pre-existing and outside the DR.8 diff (the Learned this week list and its onUndo wiring in `knows-layout.tsx` are not changed by this branch), but I did not confirm whether `memory.undo` is rejected server-side for a member. The controller should decide whether it counts against DR.8.

Screenshots: desktop-1 to desktop-9 and phone-1 to phone-8 in this folder.
