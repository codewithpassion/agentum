Verdict: pass

Task TM.11, "Home hides empty team groups; one member picker". Branch task/TM.11-home-groups-and-one-picker, dev server on port 3411, headless Chromium, agent-browser session `tm11-verify`. Dev login worked (made the Dev Workspace). Desktop is 1280x800, phone is 390x844, and each phone check reloaded after resizing.

Setup notes. `bun scripts/dev/seed-fake-agent.ts` made "Fake echo". The UI cannot create a second agent without an Anthropic key or machine ("Nowhere to run it yet"), so I made "Second agent", "Third agent" and "Fourth agent" with a scratch script in tmp/TM.11 that calls the same agents service with the fake runtime (no source files touched). I also used two direct SQLite writes on the local dev DB to provoke the add refusal (see C).

## A. Fresh workspace, no agents

Steps: dev login, land on /home.
Desktop (desktop-1.png): the first-run guide shows ("Add your AI account", "Pick a template or describe an agent", template cards). No team group headings. scrollWidth 1280.
Phone (phone-1.png): same guide, stacked. No group headings. scrollWidth 390.
Result: pass.

## B. Fresh workspace with agents (Fake echo, Second agent, Third agent, no teams joined)

Desktop (desktop-2.png): three agent cards in a flat wall, then the dashed "New agent" and "Start from a template" cards. Headings on the page: only "Home". No "Everyone" or "No team" heading, no "Add to team" card.
Phone (phone-2.png): same, single column, no headings, no "Add to team" text, scrollWidth 390.
Result: pass.

## C. Two teams, member picker, Add to team dialog

Steps: /teams, New team (dialog has Name, agent checkboxes, Lead, people checkboxes). Created "Alpha" with no agents, then "Beta" with no agents. On Alpha's team page picked "Fake echo" in "Add an agent" and clicked Add (desktop-4.png): Fake echo listed as a member and removed from the picker.
Desktop /home (desktop-6.png): headings "Alpha" ("No lead · 1 agent", Open room link to /teams/<alpha>/room, Fake echo, dashed "Add to team" card) and "No team" ("2 agents", Second and Third). No "Beta" group, no "Everyone" heading. "No team" is last and has no "Add to team" card (it has no team to add to; I note it, the brief does not ask for one).
Dialog (desktop-7.png): title "Add to Alpha", labelled select "Add an agent" with placeholder "Choose an agent", options only Second agent and Third agent (Fake echo, already in Alpha, is absent), Add button disabled until a pick. Picked Second agent, clicked Add: dialog closed at once, and Home showed Second agent inside Alpha with "2 agents" (desktop-8.png). The card moved because an agent with no home team takes the team it is added to as its home team.
Phone (phone-3.png full page, phone-4.png dialog, phone-5.png after add): groups stack in one column, Open room sits at the right of the Alpha heading (right edge 374px), Add to team card is full width. Dialog fits (width 358px, select 273px wide, Add button 45px wide, all inside 390px). Dialog lists only Third agent. Picked it, Add: dialog closed, Home then shows a single "Alpha" group with "3 agents" and the "No team" group is gone because it is empty. scrollWidth 390 throughout.
Everyone heading with another team (desktop-9.png): after adding Fourth agent to Everyone (its home team becomes Everyone) Home shows "Alpha" (3 agents) and "Everyone" (1 agent), each with Open room and Add to team. The Everyone dialog lists only agents not in Everyone. Later state (desktop-11.png, phone-9.png): Alpha, Everyone, No team in that order, "No team" last.
Add refusal: not reachable through normal UI clicks. Adding an agent that is already a member (inserted row directly) just closes the dialog (idempotent). To force a refusal I opened the Alpha dialog, archived Fourth agent in the local DB, then picked it and clicked Add: the dialog showed the red message "Agent must be active in this workspace" under the select (desktop-14.png) and stayed open. About 3 seconds later the poll refreshed the list and the dialog showed "Every agent is already in this team." with only a Close button (desktop-13.png). That one 400 in the console below comes from this induced refusal. I restored the agent to active afterwards. Not repeated at phone size.
Result: pass at both sizes.

## D. Everyone-only

The UI has no direct "set home team" control, but home team is the agent's first team membership, so I could set it up: removed Fake echo, Second agent and Third agent from Alpha on its team page (Fake echo kept its Everyone membership, which became its home team), and Fourth agent was added to Everyone first (home Everyone). Result: Everyone holds 2 agents, three agents are in no team, nobody is in another team.
Desktop /home (desktop-10.png): flat wall of four cards, then New agent and Start from a template. Headings on the page: only "Home". No "Everyone", no "No team", no "Add to team", no Open room link.
Phone (phone-6.png): same, scrollWidth 390.
Result: pass.

## E. Team page Open room link

Desktop /teams/<alpha> (desktop-3.png): header shows "Open room" (outlined) next to the orange "New team" at the top right; link href /teams/01M7WGSX2YYX889ZSQ9TTAF6FP/room (accessible name "Open room for Alpha"). Clicked it: landed on /teams/<alpha>/room, page renders "Alpha / Team room", "New topic", "No topics yet.", "Pick a topic, or start a new one." (desktop-5.png). scrollWidth 1280.
Phone (phone-7.png): header shows "All teams", "Alpha" and both buttons side by side (Open room right edge 280px, New team right edge 374px), no wrap needed at 390px for a short name and no sideways scroll. Clicked Open room: /teams/<alpha>/room renders, with a "Topics" button in place of the side list (phone-8.png). scrollWidth 390.
Home group heading link: desktop, clicked "Open room for Alpha" on Home: landed on /teams/<alpha>/room (desktop-12.png). Phone, clicked "Open room for Everyone": landed on /teams/<everyone>/room and rendered (phone-10.png).
Result: pass.

## Console and network

Clean pass at the end (Home, /teams, a team page and its room at both sizes, console cleared first): no console errors, no resource with status >= 400, scrollWidth equal to the viewport width on all eight loads. Per-flow checks used the same resource-timing check and browser console. Dev server log (tmp/TM.11/dev.log) has no errors.
Errors seen during the whole run:
- One 401 (Unauthorized) in the console right after the dev login redirect, before the first /home load. Expected after dev login, not from a TM.11 action.
- One 400 (Bad Request) from the induced add refusal in the Add to team dialog (see C). Expected, and the dialog showed the error message.
- Only other console output: Clerk development-keys warnings, WebGL fallback warning, "No available adapters" warning, Vite debug lines. No favicon 404 was seen.

## Files

desktop-1 A first-run guide. desktop-2 B flat wall. desktop-3 team page header (before add). desktop-4 team page after adding Fake echo. desktop-5 room after Open room click. desktop-6 C Home with Alpha and No team. desktop-7 Add to Alpha dialog. desktop-8 Home after Add (dialog closed). desktop-9 Alpha and Everyone groups. desktop-10 D flat wall. desktop-11 Alpha, Everyone, No team. desktop-12 room reached from Home heading link. desktop-13 dialog empty state "Every agent is already in this team." desktop-14 dialog refusal message.
phone-1 A first-run guide. phone-2 B flat wall. phone-3 C Home groups (full page). phone-4 dialog. phone-5 Home after Add (full page). phone-6 D flat wall. phone-7 team page header. phone-8 room. phone-9 Home with Alpha, Everyone, No team (full page). phone-10 Everyone room reached from Home heading link.
