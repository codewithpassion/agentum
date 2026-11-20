Verdict: fail

# DR.8 browser verification

Run against the dev server at localhost:3100 (worktree DR.8, branch task/DR.8-held-dream-batch-approval), headless Chromium, viewports 1280x800 and 390x844. Admin session: dev@rockyshoreslabs.io (org admin, creator/owner of the agent). Plain member session: dev+member@harbouredgeintelligence.ai (org member), signed in through `agent-login` in a separate session with a fresh profile.

## Setup deviations

- "New agent" could not create an agent in the app: the form says "Nowhere to run it yet. Add an Anthropic API key or a machine in Settings", and a placeholder key is rejected ("Anthropic did not accept that key"). I inserted one agent row ("Scout", runtime `fake`, created_by = the dev user) straight into the local D1, then ran the seed script. The room shows "Owner: Dev User", so ownership matched.
- Shared browser profile: my first `dr8-verify` session came up signed in as the plain member, not the admin (an existing profile was reused, so the dev-login token did not switch user). Everything below the admin flows was redone in a session with its own `--profile`, which signed in as the admin (checked through `window.Clerk`). That first member view is not used for the verdict.
- The seed script writes `base_version = '[]'`. Once Scout's memory files exist (after the first approve), approving a freshly seeded batch fails with the 409 "Memory changed since this dream ran, so its changes no longer fit. Reject them." That is the app correctly detecting a stale base, caused by my reseed. For the phone run I forgot the two notes in the UI and set batch A's `base_version` to the current people.md and work.md version ids. The three 409 console errors come from this and are not a defect.

## Results

| Flow | Desktop | Phone |
|---|---|---|
| F1 Knows diary | pass | pass |
| F2 Needs you cards | pass | pass |
| F3 Approve | fail (wording, stale card) | fail (wording) |
| F4 Reject | pass with a wording issue | pass with a wording issue |
| F5 Read-only member | fail (extra buttons) | fail (extra buttons) |

### F1 Knows tab (desktop-1.png, phone-1.png)
Opened Scout, then Knows. The newest held dream ("Today's dream") shows its proposed change (Added a note, "The Sydney office is on Level 4.", "Held for your approval") with Approve and Reject. The older batch sits under Earlier dreams with a Held badge, both proposed notes, and its own Approve and Reject. Neither shows "Done" or applied counts, and neither has an Undo this night button. Needs you shows 2. No horizontal scroll at 390 (scrollWidth 390).

### F2 Needs you (desktop-2.png, desktop-3.png, phone-2.png, phone-3.png)
The drawer lists two cards, both headed "Scout has dream changes waiting for your approval". Opening the older card (`/desk?item=<run id>`) shows the two proposed notes with Approve and Reject. Count was 2 at both sizes.

### F3 Approve
Desktop, from the Needs you card (desktop-4.png, desktop-5.png). Phone, from the Knows tab (phone-4.png).
- Notes: the people note and the work note now appear under What Scout remembers ("Found in a dream, 20 Nov"). The held batch is gone from the diary and replaced by an earlier-dream row "Done, Added 2 notes." The Needs you count dropped from 2 to 1 at both sizes. Works.
- Fail 1: the diary never shows "You approved these changes." The text is in `dream_runs.diary` (verified in D1), but the Earlier dreams row only shows "Done / Added 2 notes." with a See changes link, and expanding it does not show the line either.
- Fail 2 (desktop, from the Needs you card): after clicking Approve the card stayed on screen showing "Loading the changes." with live Approve and Reject buttons (desktop-4.png), even though the count had dropped. Reloading the URL shows "That item is not waiting any more." On phone, Reject from the card left the card cleanly to "Nothing needs you", so this seems tied to approve, or to another card still waiting.

### F4 Reject
Desktop, from the Knows tab (desktop-6.png). Phone, from the Needs you card (phone-5.png, phone-6.png, phone-7.png).
- Memory unchanged: the Sydney (places) note does not appear under What Scout remembers, and `places.md` was never written. The held row and card disappeared and the count dropped to 0 (phone: "Nothing needs you").
- The diary shows "You rejected these changes. Nothing was changed." in the dream's text.
- Wording issue: the same rejected dream still shows "Added 1 note." with a See changes link underneath, and, as an earlier dream, "Done / Added 1 note." That contradicts "Nothing was changed" and misleads. The summary should not claim an addition for a rejected batch.

### F5 Read-only member (desktop-7.png, desktop-8.png, phone-8.png, phone-9.png)
Signed in as dev+member@...: both held batches show their proposed changes and the text "These changes wait for the agent's owner or an admin to approve." The diary has no Approve or Reject. The Needs you drawer says "Nothing needs you." with counts 0. Those parts pass.
Fail: the What Scout remembers list on the same Knows tab still shows each held note as "Wants to remember ... Waiting for you / A dream" with Approve and Reject buttons, visible to the member (3 pairs in the snapshot, at both sizes). Members should see no decision buttons. I did not click them, so I do not know what they do (the spec says `memory.decide` refuses dream rows). The admin view shows the same extra per-note pairs, which duplicate the batch controls.

## Console and network
- Console errors seen: one 400 and one 400 (Bad Request) on resource loads from the early sign-in phase (Clerk dev-login and the shared profile mix-up), and three 409 from the stale-base approves described above. Nothing else. A Clerk development-keys warning is expected.
- `agent-browser network requests` returned "No requests captured" in the final sessions, so I could not list failed requests beyond the console. The pass criterion "no console errors and no failed requests" is not met as recorded, though the only app-caused errors are the 409s from the reseed.

## Failures for the builder
1. Approved dreams do not show "You approved these changes." in the diary (only "Done / Added N notes.").
2. After Approve on the Needs you card (desktop) the card stays on "Loading the changes." with live buttons.
3. Rejected dreams still say "Added N note(s)." next to "Nothing was changed."
4. The remembered-notes list shows Approve and Reject on held dream notes, including to a plain member.

## Screenshots
desktop-1 Knows (admin, two held). desktop-2 Needs you drawer. desktop-3 opened card. desktop-4 card after Approve (stuck). desktop-5 Knows after Approve. desktop-6 Knows after Reject. desktop-7 member Knows. desktop-8 member Needs you.
phone-1 Knows. phone-2 Needs you drawer. phone-3 opened card. phone-4 Knows after Approve. phone-5 drawer with the second card. phone-6 after Reject from the card. phone-7 Knows after Reject. phone-8 member Knows. phone-9 member Needs you.
