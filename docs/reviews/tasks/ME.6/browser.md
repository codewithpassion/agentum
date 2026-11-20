# ME.6 browser check: Knows tab

Branch `task/ME.6-knows-tab` at bb5fbe11, run with `vite dev` on port 3921 against the local D1 database. Headless Chromium through agent-browser. Desktop is 1280x800, phone is 390x844. The owner session (`me6-verify`) signed in as Dev User through `/api/dev-login`. Dev User is an admin of Dev Workspace and the owner of Scout. The page under test is `/agents/01M7VE6XAK8BGTT7JVV64QENJR?tab=knows`.

The local database already held changes from the dispatcher's smoke run, so Learned this week already had three rows at the start, and the learn level was set to Ask me first.

## 1. Open the Knows tab

Steps: sign in, open the Knows tab, read the panel text, measure the headings and the page scroll width.

Desktop: the left column shows What Scout remembers (with the Add a note form), then Skills, Instructions and Voice. The right column shows Remember rules: the Remember list, Never remember with three locked rows (Passwords and keys, Card and bank numbers, Health details, each marked "workspace rule"), How it learns with three levels (Ask me first, Tell me after, Quietly), the Shares with team switch, and then Learned this week. Notes are on the left and rules on the right, as specified.

Phone: one column in this order, measured by heading position: What Scout remembers (y 397), Remember rules (697), Learned this week (1281), Skills (1857), Instructions (2233), Voice (2329). `scrollWidth` equals the viewport (390), and `scrollTo(500, 0)` leaves `scrollX` at 0, so the page has no horizontal scroll. Only the tab strip overflows, inside its own scroll container.

Dream card slot: `[data-slot="dream-card"]` is the first element in the tab panel, before any heading. It is empty, has `display: none` and a height of 0 at both sizes.

Screenshots: `desktop-1.png`, `phone-1.png` (full page).

## 2. Add a note by hand

Desktop: I chose kind Corrections, typed "Desktop: send weekly summary on Fridays" and clicked Add note. The note appeared under a "Corrections" heading with "Added by hand, 20 Nov" and Edit and Forget buttons. Learned this week gained "Remembered: Desktop: send weekly summary on Fridays, today". The Add note button stays disabled until the text box has content.

Phone: I chose Where things are and added "Phone: invoices live in the Finance drive". It appeared under "Where things are" with "Added by hand, 20 Nov", and Learned this week gained a matching Remembered row.

The learn level was Ask me first during the desktop add. The hand-added note still applied at once and was not held.

Screenshots: `desktop-2.png`, `phone-2.png`.

## 3. Edit the note

Desktop: Edit opened an "Edit note" box with Save (disabled until the text changes) and Cancel. I changed Fridays to Thursdays and clicked Save. The note then read "Desktop: send weekly summary on Thursdays", and Learned this week gained "Changed a note to: ... Thursdays, today".

Phone: I changed "Finance drive" to "Accounts drive" and clicked Save. The note text and Learned this week updated the same way.

Screenshots: `desktop-3.png`, `phone-3.png`.

## 4. Learned this week and Undo

At both sizes Learned this week listed the add and the edit as separate rows, newest first, each with an Undo button.

Desktop: Undo on "Changed a note to: ... Thursdays" removed that row, and the note went back to "... on Fridays".

Phone: Undo on "Changed a note to: ... Accounts drive" removed that row, and the note went back to "... Finance drive".

Screenshots: `desktop-4.png`, `phone-4.png`.

## 5. Forget a note

Desktop: Forget opened a dialog titled "Forget this note?" with the quoted note text and Cancel and Forget buttons. I confirmed. The note list went back to "Nothing remembered yet.", and Learned this week gained "Forgot: Desktop: send weekly summary on Fridays, today" at the top.

Phone: the same dialog appeared. After I confirmed, the note was gone and "Forgot: Phone: invoices live in the Finance drive, today" headed Learned this week.

Screenshots: `desktop-5.png`, `phone-5.png` (full page).

## 6. Rules as owner or admin

Desktop: I changed the learn level from Ask me first to Tell me after, back to Ask me first, and then to Tell me after again. I turned Shares with team off. I added "Customer time zones" to Remember and "Home addresses" to Never remember, and both appeared with a Remove button. The three workspace rows have no Remove button. I removed "Home addresses", and it disappeared. After a reload the page showed Remember "Customer time zones", the three workspace rows only, Tell me after selected, and Shares with team off. Every change persisted.

Phone: I changed the level to Ask me first and back to Tell me after, and turned Shares with team on again. I added "Preferred meeting times" to Remember and "Salaries" to Never remember, then removed "Customer time zones". After a reload the page showed Remember "Preferred meeting times", Never remember with the three locked rows plus "Salaries" (which has Remove), Tell me after, and Shares with team on. Every change persisted. Again the workspace rows had no Remove button.

Screenshots: `desktop-6.png` (full page after reload), `phone-6.png` (full page after reload).

## 7. A member cannot change rules

Setup: I created a Clerk dev user `dev+member@harbouredgeintelligence.ai` through the Backend API and added it to Dev Workspace as `org:member`. It is neither an admin nor Scout's owner. I signed it in with `bun run agent-login --base-url http://localhost:3921 --redirect ...` in a fresh session `me6-verify-member`. The page confirmed the user as `dev+member@...`, organisation Dev Workspace, role `org:member`.

Desktop: Remember rules shows "Only the owner or an admin can change these." The accessibility tree marks every rules control as disabled: both Remove buttons, both add text boxes, both Add buttons, all three learn level radios, and the Shares with team switch. The member could still add a note. "Member: Sam reviews leads on Mondays" appeared under About people with "Added by hand, 20 Nov".

Phone: after a reload at 390 wide, the same message showed and the same ten rules controls were disabled. No horizontal scroll (scrollWidth 390).

Server check, beyond the UI: as the member I called `memory.rules.set` directly with the agent's current rules. The server refused with 403 "Not allowed: memory.rules.write". My first try sent a malformed payload and got a 400 from input validation. These two failed requests were my own probes, not the page's.

Screenshots: `desktop-7.png`, `phone-7.png` (full page).

## 8. Held notes: Approve and Reject

Setup: I inserted held `add` changes with kind people and `written_by` agent into `memory_changes` with `wrangler d1 execute --local`. The first pair was "Mia likes Tuesday reports" and "Mia prefers calls after 2pm". The second pair was "Raj wants CSV exports" and "Raj is on leave in December".

Desktop: after a reload both held notes showed under About people as "Wants to remember", with the text, a "Waiting for you" badge, "The agent", and Approve and Reject buttons. Approve on "Mia likes Tuesday reports" made the note join the list as "Noted by the agent, 20 Nov" with Edit and Forget, and Learned this week gained "Remembered: Mia likes Tuesday reports, today". Later, Reject on "Raj is on leave in December" removed the held row and added no note.

Phone: the held rows showed the same way. Reject on "Mia prefers calls after 2pm" removed it. Approve on "Raj wants CSV exports" turned it into a note marked "Noted by the agent". A reload kept the result.

Database after the clicks: H01 and H03 are `applied`, H02 and H04 are `rejected`, and all four have `decided_by` set. No service errors.

Screenshots: `desktop-8.png` (two held rows at desktop), `phone-8.png` (held row at phone with Approve and Reject).

## Console and network

After every flow I read `agent-browser console` and listed resources with `responseStatus >= 400`, or a status of 0 on same-origin requests, from the Performance API. agent-browser's `network requests` lists URLs without status codes. The browser also logs a "Failed to load resource" error for any 4xx or 5xx response.

- Owner session: no console errors and no failed requests during flows 1 to 8. The only error was one "Failed to load resource: 400" during the first sign-in, from the dev-login and Clerk step before the Knows tab loaded. The brief named this as out of scope.
- Member session: the 400 and 403 responses from my own direct `memory.rules.set` probes (see flow 7). The page made no failing request. I also saw warnings, not errors, for the software WebGL fallback and "No available adapters". They appeared after the member sign-in and do not come from the Knows tab.
- Warnings in both sessions: Clerk's development keys warning (out of scope).
- Dev server log: no errors.

Findings that do not block:

- In dev builds the floating TanStack Devtools button (bottom right) covers the Shares with team switch at desktop and a Remove button at phone, depending on scroll position. It is dev only and not part of ME.6, but it can get in the way of manual testing.
- The note Edit and Forget buttons and the rule Remove buttons have only generic accessible names. The note Edit button shares the name "Edit" with the agent header's Edit button. A screen reader user cannot tell which note or rule a button acts on.

Verdict: pass
