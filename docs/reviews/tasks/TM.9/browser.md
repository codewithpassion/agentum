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
