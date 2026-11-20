# ME.13 browser verification

Commit 5400d79, branch task/ME.13-a-way-to-start-a-private-conversation. Real Chromium via agent-browser, dev server on port 3913 (PUBLIC_BASE_URL set to match), local D1 migrated fresh. Two browser sessions: the dev user (dev login) and dev+member@harbouredgeintelligence.ai (agent-login, already a member of Dev Workspace; nothing created in Clerk).

## Setup
- Agent "Privacy Tester" (runtime fake, model fake) created as the real dev user through the signed-in browser session calling the agents.create tRPC mutation (the UI builder needs a model key). The agent has an owner row of the dev user shown on its page, learn level default ("Ask me first" was not needed: the Remember action saved notes directly).
- Desktop 1280x800 and phone 390x844. No horizontal overflow at phone width (scrollWidth 390).

## Flows (desktop / phone)
A. New conversation dialog. Desk board "+ New conversation" (desktop-2, phone-2) and the agent page "Run now" dialog (desktop-9, phone-13; the room's other "New conversation" button opens the main chat, not this dialog). The dialog has a labelled "Private" switch, off by default, with the line "Notes remembered from this conversation stay with you. Other members never see them." At phone width the dialog fits, nothing overlaps, the switch is reachable. PASS both sizes.
B. Private (switch on, desktop-3 / phone-3) and normal (off, desktop-5 / phone-7) conversations started with distinct messages. Each thread opened and the fake agent replied with an echo (desktop-4, phone-4). PASS both sizes.
C. Message menu, Remember, saved with a "Remembered" toast in both the private and the normal thread (desktop-6, -7, -8; phone-5, -6, -8, -9, -10, -12). PASS both sizes. (Two automation retries saved one phone normal note twice; this is my tooling, not the app.)
D. Knows tab as dev user: the private notes carry a "Private" badge, the normal notes carry none (desktop-11, phone-11). PASS both sizes.
E. Second member, own session:
 - Library agents/privacy-tester/memory lists index.md, work.md and a `private` folder; the folder is empty for the member, and work.md holds no private text (desktop-12, -13, -14; phone-14, -15). The private note's file (private/<dev user id>.md) is not listed.
 - PROBE (deliberate, once per size): direct library URL to the private file shows "Not found" (desktop-15, phone-16); a direct tRPC library.read GET answered 404.
 - Knows tab lists only the normal notes, no badge, no private text (desktop-16, phone-17).
 - The member sees neither the private nor the normal conversation in Conversations, the desk board, home or the agent page (desktop-17, -18, phone-18); the dev user control sees both. PROBE: member opening the private thread URL gets "Conversation not found" (404, expected).
 PASS both sizes.

## Observations
- Minor: a member can see that an empty `private` folder exists under agents/privacy-tester/memory (name only, no contents).
- The thread page shows no private indicator on a private conversation (not in the task scope).

## Console, network, server
- Dev user and member, all flows at both sizes: no console errors and no failed requests apart from the labelled probes (404 on the private-file read and on the private thread, per size).
- One "Failed to load resource ... 400" appeared in the dev user's console right after the first dev login (initial sign-in, before any flow). A fresh dev login in a clean session afterwards produced no error, and reloads did not repeat it, so I could not reproduce or attribute it; treated as sign-in noise.
- One self-inflicted 500 "Agent not found": I opened /agents/privacy-tester (the route takes the id, not the slug). Not an app defect.
- vite.log: the only errors are that wrong-URL one and the Clerk development-keys warning.

## Verdict
PASS. Every flow works at both sizes. Caveat: the single unreproduced sign-in 400 above.
