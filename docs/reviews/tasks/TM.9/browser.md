# TM.9 browser verification (head 92908ed7)

Dev server on port 5188 (own PIDs), fake agent seeded, dev login, agent-browser session `tm9-verify2`, chrome-headless-shell. Desktop 1280x800, phone 390x844. Topics and teams created by me: Everyone topics "Verify2 desktop everyone" (01M7WR4YVCHNMXD8X449Z64RM4) and "Verify2 phone everyone" (01M7WRCEJT8JFQ7M5PHTJA4VNY); teams "V2 Desktop Team" (01M7WR5XNFJ8ERHKV8CPNSJQW1, topic 01M7WR751MG4E6T2RBHAAK2YA4) and "V2 Phone Team" (01M7WRD9Y8N98931F9590HP1D3, topic 01M7WRDSGC191EF49K2EM3HJ6T). Everyone team id: 01M7WQ0CNMC184NQHW1MJ2JK9P.

Console and network: every flow was read with `console` and `errors` (cleared before each). Only the ignorable lines appeared: Vite connect debug lines, the React DevTools info line, the Clerk development-keys warning. No page errors. agent-browser's request log has no status codes, so failed requests were judged by console "Failed to load resource" lines plus a direct fetch (see D). `wait --load networkidle` never settles on the room page (the room polls inbox.listThreads), so fixed waits were used.

## A. Plain /inbox
Desktop: opened /inbox, landed on /teams/01M7WQ0CNMC184NQHW1MJ2JK9P/room, heading "Everyone", topic list and "Pick a topic, or start a new one." (desktop-1.png). Pass.
Phone: same URL, heading "Everyone", hint shown, topic list behind the "Topics" button (phone-1.png, phone-2.png). Pass.

## B. Everyone topic, then old link
Desktop: New topic "Verify2 desktop everyone", posted "hello desktop everyone post", opened /inbox?thread=01M7WR4YVCHNMXD8X449Z64RM4. Landed on the Everyone room with `?topic=` that id, topic open, post visible (desktop-2.png). Pass.
Phone: same with "Verify2 phone everyone" and its post (phone-3.png). Pass.

## C. Second team
Desktop: Teams, New team "V2 Desktop Team", opened its room, created topic and post, opened /inbox?thread=<that id>. Landed on /teams/01M7WR5XNFJ8ERHKV8CPNSJQW1/room?topic=<id>, heading "V2 Desktop Team", post visible (desktop-3.png). Pass.
Phone: same with "V2 Phone Team" (phone-4.png). Pass.

## D. /inbox?thread=does-not-exist
Desktop: landed on /teams/01M7WQ0CNMC184NQHW1MJ2JK9P/room with no `topic` param, heading "Everyone", topic list visible, "Pick a topic, or start a new one." Stayed 22 seconds. Console and page errors empty (desktop-4.png). Pass.
Phone: same URL and hint; the topic list opens from "Topics" and shows all Everyone topics (phone-5.png, phone-6.png). 22 seconds, console and errors empty. Pass.
Finding (not part of the flow as specified, does not change the verdict): the redirect probes `inbox.readThread`, which answers 404 NOT_FOUND for an unreadable id (confirmed by direct fetch: 404 "Thread not found"). On a full page load the probe runs on the server, so the browser sees nothing. When the same URL is reached by in-app (client-side) navigation, the browser makes that fetch and logs one console error "Failed to load resource: 404". I reproduced this by pushing /inbox?thread=does-not-exist inside a loaded app. The landing is still correct (Everyone room, no topic). Only a stale or invalid id reached from inside the app would hit it.

## E. Find
Desktop: Ctrl+K lists Teams (Everyone, Marketing, Sales, V2 Desktop Team) and "Everyone room", "Marketing room", "Sales room", "V2 Desktop Team room". No "Inbox" option and no "Threads" text anywhere in the palette (desktop-5.png). Picked "V2 Desktop Team room": opened /teams/01M7WR5XNFJ8ERHKV8CPNSJQW1/room (desktop-6.png). Pass.
Phone: Menu, Find: same list including "V2 Phone Team room", no Inbox or Threads (phone-7.png). Picked "V2 Phone Team room": opened its room (phone-8.png). Pass.

## F. Needs you
Desktop: in "Verify2 desktop everyone" typed "@fake", picked "Fake echo @fake-echo" from the mention list, sent "@fake-echo hello". The agent replied within 8 seconds ("Echo: @fake-echo hello"). The bell went from 2 to 3. The drawer listed "Verify2 desktop everyone, Fake echo replied" (desktop-7.png). Opening it went to /desk?item=<topic id> with an "Open thread" button (desktop-8.png; its href is /inbox?thread=<topic id>). Clicking it landed on /teams/01M7WQ0CNMC184NQHW1MJ2JK9P/room?topic=<topic id> with the topic open (desktop-9.png). Console clean. Pass.
Phone: same on "Verify2 phone everyone"; bell 3 to 4; drawer item (phone-9.png); desk card with "Open thread" (phone-10.png); click landed in the Everyone room with that topic open (phone-11.png). Console clean. Pass.

## G. Back button
Desktop: /home, then /inbox?thread=<V2 Desktop Team topic> (full load), redirected to the team room; Back went to /home, not /inbox (desktop-10.png). Back from the room reached via the desk card's "Open thread" (client-side) went to the desk card, not /inbox. Pass.
Phone: /home, then /inbox?thread=<V2 Phone Team topic>, redirect, Back went to /home (phone-12.png). Plain /inbox then Back also went to /home. Back from the room reached through "Open thread" went to the desk card. Pass.

Verdict: pass (all flows A to G at both sizes, no console errors or failed requests in the flows as specified; one 404 console error only when a made-up thread id is reached by in-app navigation, noted under D)

## Round 3 (1c7b8dc1): no-404 redirect

Dev server on port 5188 (PIDs 2716684 and 2716796, both stopped at the end), local D1 migrations applied, dev login, agent-browser session `tm9-verify3`, chrome-headless-shell. Desktop 1280x800, phone 390x844. Topics and teams created in this round: Everyone topics "R3 desktop everyone" (01M7WTFRDYTY4E51N2ENCZT9AM) and "R3 phone everyone" (01M7WTNSDNKJXZEGC5J3X1T6JB); teams "R3 Desktop Team" (01M7WTHA8GS4M8WEQ2HC58ECZ5, topic 01M7WTHQ67DHFNH5WCKW4AA0B7) and "R3 Phone Team" (01M7WTPW2MV6YRDWF5G9HZ1BAH, topic 01M7WTQB3BN5DT7TRMA6YAY21V). Everyone team id: 01M7WQ0CNMC184NQHW1MJ2JK9P.

How "in-app" navigation was done: the app exposes `window.__TSR_ROUTER__`, so after loading a signed-in page I ran `__TSR_ROUTER__.navigate({to:'/inbox', search:{thread:<id>}})`. That is a client-side navigation with no page reload, so the `inbox.topicTeam` query runs from the browser. Before each in-app navigation I cleared the console and error log and wrapped `window.fetch` to record the HTTP status of every request (agent-browser's request log has no status codes). For full page loads I read `performance.getEntriesByType('resource')` for any entry with status 0 or 400+.

Console and network: in every flow the console held only ignorable lines (Vite connect debug lines, the React DevTools info line, the Clerk development-keys warning; these appear only after a full page load). No "Failed to load resource" line, no page error, no `errors` output. Every recorded fetch returned 200, including `inbox.topicTeam` for the made-up id `does-not-exist` (200, answers null) and for the real ids. No 404 anywhere, so the Round 2 console error is gone. `wait --load networkidle` still never settles on the room page (it polls `inbox.listThreads`), so fixed waits were used.

### D. /inbox?thread=does-not-exist
Desktop, in-app navigation: from /home, router navigate to /inbox?thread=does-not-exist. Landed on /teams/01M7WQ0CNMC184NQHW1MJ2JK9P/room with no `topic` param, heading "Everyone", topic list visible, "Pick a topic, or start a new one." (desktop-r3-1.png). `inbox.topicTeam` returned 200. Stayed 24 seconds, console and errors empty. Pass.
Desktop, full page load of the same URL: same landing, same hint (desktop-r3-2.png). After 21 seconds the console held only the Vite, React DevTools and Clerk lines, no errors, no resource with status 0 or 400+. Direct unauthenticated fetch of `inbox.topicTeam` answers 401, as expected. Pass.
Phone, in-app navigation: same URL and hint, topic list behind the "Topics" button (phone-r3-1.png). 24 seconds, console and errors empty, `inbox.topicTeam` 200. Pass.
Phone, full page load: same landing (phone-r3-2.png), 21 seconds, only ignorable lines, no failed resources. Topics button opens the Everyone topic list (phone-r3-3.png). Pass.

### B. Topic in Everyone
Desktop: created topic "R3 desktop everyone", posted "r3 desktop everyone post", went to /home, then in-app navigate to /inbox?thread=01M7WTFRDYTY4E51N2ENCZT9AM. Landed on /teams/01M7WQ0CNMC184NQHW1MJ2JK9P/room?topic=01M7WTFRDYTY4E51N2ENCZT9AM, topic open, post visible (desktop-r3-3.png). `inbox.topicTeam` 200, console and errors empty. Pass.
Phone: same with "R3 phone everyone" and its post; landed in the Everyone room with the topic open and post visible (phone-r3-4.png). `inbox.topicTeam` 200, console and errors empty. Pass.

### C. Topic in another team
Desktop: Teams, New team "R3 Desktop Team", opened its room, created topic "R3 desktop team topic" with post "r3 desktop team post", went to /home, then in-app navigate to /inbox?thread=01M7WTHQ67DHFNH5WCKW4AA0B7. Landed on /teams/01M7WTHA8GS4M8WEQ2HC58ECZ5/room?topic=01M7WTHQ67DHFNH5WCKW4AA0B7, heading "R3 Desktop Team", topic open, post visible (desktop-r3-4.png). `inbox.topicTeam` 200, console and errors empty. Pass.
Phone: same with "R3 Phone Team" and "R3 phone team topic"; landed in /teams/01M7WTPW2MV6YRDWF5G9HZ1BAH/room?topic=01M7WTQB3BN5DT7TRMA6YAY21V, heading "R3 Phone Team", post visible (phone-r3-5.png). `inbox.topicTeam` 200, console and errors empty. Pass.

### G. Plain /inbox and Back
Desktop: /home, then /inbox by full load, landed on the Everyone room (desktop-r3-5.png). Back went to /home, not /inbox (desktop-r3-6.png). Same result with an in-app navigate to /inbox: landed on the Everyone room, Back went to /home. Console clean. Pass.
Phone: same sequence. Landed on the Everyone room (phone-r3-6.png), Back went to /home (phone-r3-7.png), in-app variant also went back to /home. Console clean. Pass.

Round 3 verdict: pass (flows D, B, C and G pass at desktop and phone; the 404 console error on in-app navigation to a made-up thread id is gone, with no console errors and no non-200 requests in any flow)
