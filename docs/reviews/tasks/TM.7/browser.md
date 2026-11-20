# TM.7 browser verification (team room: topics and posts)

Run on 2026-11-20 against worktree `/home/roboto/devel/harbourmaster-wt/TM.7`, branch `task/TM.7-team-room-ui`, head `92e23647`. The verifier did not build TM.7. No source code was changed.

Verdict: pass

Every flow from A to I worked at both sizes. There are two caveats:

- One 401 came before any room page was open, during sign-out and dev login, and I could not identify it.
- The person-mention branch of flow C was not shown, because no other person in the workspace has a handle.

## Setup

- Applied local D1 migrations (`bunx wrangler d1 migrations apply DB --local`, through `0060_solid_black_widow.sql`) on the wiped database.
- Started `bunx vite dev --port 3791` (PID 1613025, own process group). The log is `/home/roboto/devel/harbourmaster-wt/tmp/TM.7/verify-dev.log`.
- Browser: agent-browser session `tm7-verify3` with the Playwright headless shell from `AGENT_BROWSER_EXECUTABLE_PATH`. Desktop 1280x800, phone 390x844.
- Sign-in: the browser still held a Clerk session from an earlier daemon. On the wiped database the app said "Dev Workspace has no Agentum workspace". I signed out, opened `/login` and clicked "Dev login (local only)". That landed on `/home` with the Dev Workspace created. I did not need `create-dev-user`.
- `bun scripts/dev/seed-fake-agent.ts` created `fake-echo` ("Fake echo", `01M7WAPZ7QB6070KT59V2D2VBD`).
- Through tRPC `fetch` from the signed-in page, I created:
  - agents Quill (`quill`), Bramble (`bramble`) and Wren (`wren`), all with runtime and model `fake`.
  - my own person profile, handle `dom-dev`, name "Dom Dev".
  - team "Quill crew", with lead Quill, Wren as a member and me as a member.
  - team "Back office", with lead Fake echo and no person members. I am its owner but not a member.
- I am user `user_3Kk8S5uJZvRLPGiEoZ8ZfJfCH8m`, "Dev User". The Clerk org has five other people (Admin HM, Dev Member, Ky6 Member, Member Tester, Member2 HM). None of them has a handle, and I cannot set one for another person through `teams.profiles.set`.
- Everyone team id: `01M7WAPF5ZCE475GANP6DZ4MFY`.
- To test scrolling I made 15 extra Everyone topics ("Filler topic 1" to "Filler topic 15") with `inbox.createThread`.
- How the agents were spread: Fake echo took the Everyone flows (C, D) and the Back office lead reply. Quill and Wren took flow F. Bramble took flow G. Every mention I sent got a reply. The Quill and Wren exchange in F stopped after 4 replies both times. I did not check why.

How I checked for errors: agent-browser's `network requests` list has no status codes. So failed requests come from Chrome's console, which logs "Failed to load resource" for every failed fetch and kept that history through every navigation and viewport change. The dev server log is a second source, but only for server errors: it did not log my deliberate 403. agent-browser only began tracking network requests at 11:16:39 UTC, when I first ran `network requests`. That was after the sign-out and before the room flows began at 11:16:43.

## A. Everyone room, New topic, topic list, phone sheet

Desktop: I opened `/teams/01M7WAPF5ZCE475GANP6DZ4MFY/room`. It showed the "Everyone" heading, "Team room", a New topic button, "No topics yet." and "Pick a topic, or start a new one." I opened New topic, typed only the title "Launch checklist" and clicked Create topic. The dialog closed and the URL gained `?topic=`. The topic opened with "No posts yet." and the composer, and it appeared selected at the top of the topic list (desktop-1). With 18 topics, the topic column scrolls on its own: scrollHeight 1172 against clientHeight 768, and scrolling to the end reaches every topic (desktop-16). Pass.

Layout note (desktop): the sticky topic column is `100dvh - 2rem` tall and does not allow for the 60px sticky top bar. In an 800px window it runs past the bottom of the screen, so the last topic needs a page scroll as well as a column scroll. The page scrolls about 145px even when the topic is short. It shows up two ways:

- On a long topic (desktop-8 to desktop-11) the page scrolls and the column pins at 16px from the top. That is under the 60px top bar, so the "Everyone" heading is hidden behind the bar and only "Team room" shows.
- On a short topic scrolled to the bottom of the page (desktop-17) the column scrolls away with the page. Its top was at -61px in the measurement, so the heading and the New topic button are out of view under the bar.

Every topic stays reachable, so I did not fail the flow, but it looks off.

Phone: the room shows "Everyone", a Topics button and "Pick a topic, or start a new one." There is no horizontal scroll (scrollWidth 390) (phone-1). Topics opens a full-width left sheet headed "Everyone topics", with New topic and all 18 topics (phone-2). The sheet scrolls (scrollHeight 1156 against 844), and at the bottom the last topic, "Launch checklist", is fully visible (phone-3). From the sheet, New topic opens the dialog over it (phone-4). Creating "Phone checklist" (title only) closed both the dialog and the sheet and opened the topic (phone-5). Reopening the sheet showed "Phone checklist" first, marked as the current topic (phone-6). Picking "Launch checklist" in the sheet closed it and opened that topic (phone-7). Pass.

The teal highlight on one row in phone-2 and phone-3 is hover, because the mouse pointer is still where the Topics button was. It is not a selection.

## B. Post with no mention

Desktop: I typed "Kicking off the launch checklist here." and clicked Send. The post shows a blue "DU" initials tile, "You" and "less than a minute ago" (desktop-2). Pass.

Phone: "Phone post, no mention." in "Phone checklist" shows the same way (phone-8). Pass.

## C. Mention completion

Desktop: typing `@` opened a "Mention suggestions" listbox with Bramble, Fake echo, Quill and Wren. Each row has a coloured letter tile, the name and the `@handle`, and the first row is selected (desktop-3). I am not in the list. No other person appears because none has a handle (see Setup), so the person branch could not be shown with data. `@fa` narrowed the list to Fake echo alone (desktop-4).

- Keyboard: I deleted back to `@`, pressed ArrowDown (selection moved to Fake echo), then Enter. The composer held `@fake-echo ` with the caret at 11, the end, and the list closed.
- Mouse: from "Hi @fa" I clicked the Fake echo option. The value became "Hi @fake-echo " with the caret at 14, and focus stayed in the composer.
- Escape: from "...please echo this. @q" (one suggestion showing), Escape closed the list and kept the text as typed.
- Send: Ctrl+Enter sent "Hi @fake-echo please echo this."

Pass.

Desktop note: the list opens upward and covers the topic title and the newest post while it is open (desktop-3). That is usual for a popover, but it hides the context you may be replying to.

Phone: the same list spans the full width (x 16 to 374). Each row is 40px tall and easy to read (phone-9). `@fa` narrows to Fake echo (phone-10). ArrowDown and Enter gave `@fake-echo ` with the caret at 11. Picking with a click gave "Hi @fake-echo " with the caret at 14 and focus kept. Escape kept "...@w" and closed the list. Send was by the Send button. Pass.

Limit: I could not do a real touch tap. Playwright refused `tap` ("The page does not support tap") because the context has no touch support. `set device "iPhone 14"` changed only the viewport (390x664) and left `maxTouchPoints` at 0. The phone pick was a mouse click at 390x844.

## D. Agent reply, Task chip

Desktop: about 5 seconds after sending, Fake echo's reply appeared with a blue "F" tile, the name "Fake echo", the echoed text and a "Task" chip (desktop-5). The chip links to `/tasks/01M7WAXB8PGZ1J4AZ4G4689RE0`. Clicking it redirected to `/threads/01M7WAXB8P21T3KJW4B3WV67XR`, the task page for "Launch checklist", marked Done, by Fake echo (desktop-6). Browser Back returned to the room with the same `?topic=`. Pass.

Phone: the reply came about 4 seconds after Send, with the same tile, name and Task chip (phone-11). The chip opened the task page `/threads/01M7WBD2DWKKR1JSVAQSQDTJR4` (phone-12), and Back returned to the topic. Pass.

The reply text is the fake runtime echoing its whole prompt, including the thread instructions and the quoted earlier posts. That makes every agent post long. It comes from the fake runtime, not TM.7.

## E. File and artifact chips

The fake runtime made no files or artifacts. No post in the run showed a file or artifact chip, and every agent post showed only the Task chip. The brief says to expect that, so E passes at both sizes (desktop-5, phone-11). The file and artifact chips themselves were not on screen in this run. The task spec covers them with component tests.

## F. "Assigned to" under a lead post

Desktop: in Quill crew I created "Site review". The New topic dialog listed only Quill and Wren, not me. I posted `@quill please ask @wren to look at this`, built with completion: `@qu` Enter, then `@wr` Enter. Quill replied with an echo that mentions `@wren`, and under that post the line "Assigned to **Wren**" appears above the Task chip (desktop-7). The agents then woke each other. I saw 4 agent replies in all (Quill, Wren, Quill, Wren), and then they stopped. Both Quill posts carry "Assigned to Wren". Wren's posts, which mention `@quill`, carry no such line, which is right because Wren is not the lead. Pass.

Phone: a new topic, "Phone site review", in Quill crew with the same message gave the same result. There were 4 agent replies (Quill, Wren, Quill, Wren), two "Assigned to Wren" lines under the Quill posts, and the line is readable at 390px (phone-13). Pass.

## G. Inline approval (seeded)

I seeded the approvals with `bun /home/roboto/devel/harbourmaster-wt/tmp/TM.7/seed-room-approval.ts <threadId>`. The script writes a waiting run and one pending request, "Deploy the demo build to staging", straight into the local SQLite file. There is no real approval from an agent. Neither seeding produced a "database is locked" error.

Desktop: topic "Release approvals --name Title". The odd title is my own command error: an agent-browser `find ... fill` call put its flag text into the field. It is not an app fault. I mentioned `@bramble` and Bramble replied. I seeded `req_seed_mwow46ug`, and about 2 seconds later a boxed card "Bramble needs you" appeared. It held "Deploy the demo build to staging", "expires in 1 h", an Input disclosure, "Note for Deny (optional)", and the buttons Allow once, Always allow and Deny (desktop-8). Needs you showed "Bramble asks before mcp.demo.deploy" among 4 items.

I clicked Allow once. The buttons went disabled at once (desktop-9). Some time between 3 and 11 seconds later, the card turned into "Allowed once by Dev User in the web app" (desktop-10). Needs you went from 4 to 3, and the approval left the list. I then posted "Thanks @bramble carry on". About 1.5 seconds later, with my post only just sent, the settled line was still there. Once Bramble's reply landed it was gone, and only posts remained (desktop-11). Pass.

Phone: topic "Phone approvals". Bramble replied, I seeded `req_seed_mwowd9hi`, and the card appeared within about 2 seconds. Its buttons stack full width at 390px: Allow once, Deny, then Always allow with "Saves a rule if one fits." (phone-14). I typed the note "Not today" and clicked Deny. About 3.5 seconds later, including tool overhead, the card read "Denied by Dev User in the web app: Not today" (phone-15). Raw badge readings at phone size: 5 just after Bramble's reply, 6 after seeding, 7 in the screenshot taken right after answering, then 6 about 8 seconds and 30 seconds later. I did not open the Needs you panel before answering at phone size. Afterwards the panel listed six "replied" topics and no approval, so the approval did leave Needs you. I cannot tell from the badge alone exactly when it was counted. I posted "Ok @bramble hold off". After Bramble's reply landed, the settled line was gone (phone-16). Pass.

Notes on G:
- Settling waits for the `requests.answer` call to return. During the wait the card shows only disabled buttons with no "Sending..." text. At desktop this took several seconds, which felt slow.
- The settled box keeps the heading "Bramble needs you" above "Allowed once by ...". The copy reads oddly once the request has been answered.
- I did not reload or leave the topic while a settled line was showing, so I have nothing to report on that. The brief says it is not expected to survive a reload anyway.

## H. Non-member, read-only

Desktop: in Back office (where I am not a member) the room showed "Back office", "Team room", no New topic button, "No topics yet." and "Pick a topic to read." To get a topic, I first called `inbox.createThread` for that team as a non-member. It was refused with 403 "Not allowed: inbox.create", which I caused on purpose. I then joined with `teams.addMember`, created "Quarterly numbers", posted "Numbers are in the shared folder." and left again with `teams.removeMember`. Fake echo, the lead, replied because the lead listens. After a reload the room listed the topic, still with no New topic button and "Pick a topic to read." (desktop-12). Opening the topic showed both posts and the Task chip. There was no composer and no Dismiss button, and in place of the composer it said "You are not in Back office, so you can read this topic but not post." (desktop-13). Pass.

Phone: the room shows "Back office", the Topics button and "Pick a topic to read." (phone-17). The sheet lists "Quarterly numbers" and has no New topic button (phone-18). Picking the topic closed the sheet. The topic has no composer and shows the same read-only line (phone-19). Pass.

## I. Limited topic ("Only these members")

Desktop: in Everyone, New topic lists Bramble, Fake echo, Quill and Wren (each marked "agent"), then Admin HM, Dev Member, Ky6 Member, Member Tester and Member2 HM (each marked "person"). It does not list Dev User, which is me. The help text says "Leave all unticked to open the topic to the whole team. You are always in it." I typed "Private echo test" and ticked Fake echo (desktop-14). Create topic opened the new topic (desktop-15). A read-only query of the local DB (`inbox_thread_members`) shows exactly Fake echo and me as its members. Pass.

Phone: from the Topics sheet, New topic, title "Phone private echo", ticked Fake echo (phone-20). Created and opened, with the sheet closed (phone-21). The DB again shows Fake echo and me. At 390x844 all nine rows fit, so I also checked a short 390x360 viewport. There the dialog scrolls (scrollHeight 458 against clientHeight 328), and Create topic can be scrolled into view (phone-22). Pass.

The topic list gives no sign that a topic is limited to some members. That may be by design, but you cannot tell "Private echo test" from an open topic.

## Console and network findings

Room flows A to I (console cleared at the start of flow A):
- Console errors: one, "Failed to load resource: the server responded with a status of 403 (Forbidden)". That is the `inbox.createThread` I sent on purpose as a non-member in flow H.
- Page errors (uncaught): none.
- Dev server log: no new errors after setup, and no 5xx during the flows. It does not log 4xx, as the deliberate 403 shows.
- Other console output was routine: Clerk's "development keys" warning, React DevTools info and Vite connect messages.

Setup, before the room flows, so not part of TM.7:
- One 500 from `desk.rail`. The dev log shows "database is locked: SQLITE_BUSY" at the moment `seed-fake-agent.ts` wrote straight to the SQLite file, which is the known effect of the seed scripts.
- One 401 during the sign-out and dev-login switch, before the workspace existed. I could not identify the request, because network tracking started later (see Setup). It came before any room page was open. I count it as outside TM.7, but it is unexplained, and the caller may weigh it differently.
- No favicon 404 showed up in the console.

## Other observations (not failures)

- The bare "Dismiss" button at the top of a topic (shown when the topic waits on you) has no label or tooltip saying what it dismisses. It clears the topic from Needs you, but on screen it reads as if it might dismiss the topic itself.
- On phone the composer stays pinned to the bottom of the screen while long posts scroll under it (phone-7, phone-13). It works, but with the fake runtime's long echoes only a little of a post shows above the composer.
- The palm-tree button at the bottom right of every screenshot is the TanStack Devtools trigger from the dev build. On phone it covers part of the Task chip and Send area, but it does not ship.

## Screenshots

Desktop, 1280x800:
- desktop-1: A, topic created and listed.
- desktop-2: B, own post.
- desktop-3: C, `@` suggestions.
- desktop-4: C, `@fa` narrowed.
- desktop-5: D, Fake echo reply with Task chip.
- desktop-6: D, task page.
- desktop-7: F, "Assigned to Wren".
- desktop-8: G, approval card.
- desktop-9: G, after the click, pending.
- desktop-10: G, settled "Allowed once".
- desktop-11: G, settled line gone after a newer post.
- desktop-12: H, non-member room.
- desktop-13: H, read-only topic.
- desktop-14: I, dialog with Fake echo ticked.
- desktop-15: I, limited topic opened.
- desktop-16: A, topic column scrolled to the end.
- desktop-17: A, layout note (heading under the top bar).

Phone, 390x844 unless noted:
- phone-1: A, empty room.
- phone-2: A, Topics sheet.
- phone-3: A, sheet scrolled to the bottom.
- phone-4: A, New topic from the sheet.
- phone-5: A, topic created, sheet closed.
- phone-6: A, sheet with the current topic.
- phone-7: A, picked a topic, sheet closed.
- phone-8: B, own post.
- phone-9: C, `@` suggestions.
- phone-10: C, `@fa` narrowed.
- phone-11: D, reply with Task chip.
- phone-12: D, task page.
- phone-13: F, "Assigned to Wren".
- phone-14: G, approval card.
- phone-15: G, settled "Denied ...: Not today".
- phone-16: G, settled line gone after a newer post.
- phone-17: H, non-member room.
- phone-18: H, sheet without New topic.
- phone-19: H, read-only topic.
- phone-20: I, dialog with Fake echo ticked.
- phone-21: I, limited topic opened.
- phone-22: I, dialog scrolling at 390x360.
