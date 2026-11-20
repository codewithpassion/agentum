# ME.7 browser verification

Verdict: pass, with the caveats at the end (Knows listing gap, expected 400 on the secret path, one unattributed console 400).

Head c607ecb. Dev server `bunx vite dev --port 5187`, local D1 migrated. Browser: agent-browser session "me7-verify" (headless Chromium), signed in through /api/dev-login.

## How the thread was made

Seeded the fake-runtime agent with `bun scripts/dev/seed-fake-agent.ts` (agent "Fake echo", slug fake-echo), then sent a message from the agent Chat tab. The dev fake runtime answered with "Echo: ..." and finished, giving a session with one user message and one finished assistant message. For the running-message check I inserted a second run (status running) with run.queued, message.user, run.started and a partial message.assistant events, no run.finished, straight into the local D1 with sqlite3 (events is append-only, so the rows were added, not edited). Session id 01M7VEVQABN5QPZVY17JB39348, page /threads/<session id>.

## Screenshots

Desktop 1280x800 (desktop-N.png) and phone 390x844 (phone-N.png):

| Flow | Desktop | Phone |
| --- | --- | --- |
| 1 Menu open on a user message, then the dialog | desktop-1 (menu), desktop-2 (dialog) | phone-1, phone-2 |
| 2 Change kind, edit text, submit on a user message | desktop-3 | phone-3 |
| 3 Assistant message: dialog, then submit; running message has no menu | desktop-4 (dialog), desktop-5 (submit), desktop-10 (running) | phone-4, phone-5, phone-9 (running) |
| 4 Open Knows from the toast | desktop-7 (desktop-6 was taken after the toast had timed out, ignore it) | phone-6 |
| 5 Note and library file | no screenshot, fetch results below | same |
| 6 Secret rejected, dialog stays open | desktop-8 | phone-7 |
| 7 Cancel and Escape, reopen starts from message text | desktop-9 (reopened after Cancel) | phone-8 |

## Results

Flow 1, both sizes: the menu shows "Remember". The dialog "Remember this" opens with the Note textarea holding the message text and Kind set to Work (options People, Corrections, Work, Places). Assistant message text prefills as "Echo: Please remember ...". On the phone the dialog fits the viewport (358px wide).

Flow 2, both sizes: desktop saved People with edited text, phone saved Places with edited text. After submit the dialog is gone, the toast reads "Remembered / Open Knows", document.activeElement is the message-menu button (aria-label "Message actions") and body.style.pointerEvents is empty.

Flow 3, both sizes: assistant message saved as Corrections (desktop) and People (phone). Same close, toast, focus and pointer-events results. With a running run, the thread had 3 menus, on the two user messages and the finished assistant message, and none on the running assistant message ("Partial answer that is still streaming").

Flow 4, both sizes: clicking "Open Knows" in the toast moved the URL to /agents/01M7VEVF1JT6Z0JANG07VHDEZP?tab=knows and the Knows tab is selected. On the phone the first attempt missed because the toast had already expired; a second try within the toast lifetime worked.

Flow 5, both sizes: a same-origin GET to /api/trpc/memory.list?batch=1 returned the notes with kind, text and source {"kind":"session","id":"01M7VEVQABN5QPZVY17JB39348"}. After both passes there were 6 notes (people, corrections, work, plus the phone ones), and the cancelled, escaped and secret notes were not among them. library.read returned agents/fake-echo/memory/people.md, corrections.md and work.md, each with entries like `id`, `date`, `source: session:01M7VEVQABN5QPZVY17JB39348`, `by: person`, `text: ...`.

Knows listing gap: the Knows tab does not list memory notes yet (it shows Instructions, Voice, Skills and proposals only). That is ME.6, not merged, and does not count as a fail.

Flow 6, both sizes: with "sk-live-abcdefghijklmnopqrstuvwxyz123456 ..." (desktop) the dialog stayed open and showed "This note looks like it holds a secret (sk- API key), so it was not kept. Notes never hold keys, tokens, passwords or card numbers." With "password=hunter2" (phone) it showed the same text with "(password assignment)". No toast, no note saved.

Flow 7, both sizes: Cancel closes the dialog, focus returns to the menu button, pointer-events clear. Reopening shows the original message text with no error. Escape closes it the same way. No notes were added.

## Console and network

- The only failed app request seen on a clean thread load and in the flows was the expected HTTP 400 from memory.add on the secret path (tRPC BAD_REQUEST), plus its matching "Failed to load resource" console error. A fresh load of the thread produced no console errors.
- One other console "Failed to load resource ... 400" showed up on desktop after flows 2 and 3 and before the secret flow. I did not catch its URL then. The network log did list a POST to Clerk's dev instance (/v1/client/sessions/.../tokens) near the start, which is the likely source, and the fetch wrapper I added after that showed no other 4xx. It did not recur on a later fresh load. Treat it as Clerk dev-instance noise, but note it was not conclusively attributed.
- No 5xx and no errors in the vite log. Warnings seen: Clerk development keys, WebGL fallback, "No available adapters" (all unrelated).
- On the phone the document scrolls horizontally (scrollWidth 424 vs 390) because of the app header's Clerk user button, not because of this feature. The dialog itself fits.
