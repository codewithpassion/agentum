# TX.7 browser verification

Verifier run on branch head b5f4fef0 (worktree TX.7), local dev server on port 5301 and fake Slack on 5302, clean database (the dispatcher's state is in tmp/TX.7/state-dispatcher). Browser session tx7-verify at 1280x800 (desktop-N.png) and 390x844 (phone-N.png). The workspace key was typed into Home from a shell variable. Screenshots desktop-12 and desktop-14 were dropped, they showed the wrong state.

## Verdict: fail on the strict rule, every flow works at both sizes

Every flow ran to its end at both sizes, and the phone pass had no horizontal overflow (page width 390 at 390). The verdict is a fail only because the console showed errors and failed requests (listed below). All of them trace to the walkthrough tools touching the local SQLite file while the app was polling it, and a control run (browser open on a room, three ticks, no other process on the file) was clean. You may rate them as harness noise. I did not, because the brief says no console error.

## Console and network

- 400 from the Clerk ticket redeem at dev login: known, ignored.
- 500 on a tRPC read (inbox.readThread, then desk.rail), twice on desktop while the browser sat on a page and team-propose.ts raised a card. The server log says "database is locked".
- One more 500 at phone size right after a second discussion was started and stopped (same time as a script write; the server log did not name the request).
- At the 08:00 tick (03:01 UTC) the browser console collected ten piped server errors ("Failed query" on inbox.readThread, desk.rail, requests.pending, artifacts.pins, skillStore.proposals, "Member lookup failed"). I had a sqlite3 read open on the same file in the same minute.
- Two 401 responses once, on the first /desk load after navigating from about:blank (Clerk session refresh). Not seen again, nothing in the resource timing at 4xx.
- Control: room open, three ticks, nothing else on the database: no console error, no failed request. Every other page load and every action in the walkthrough was clean.

## Flow 1: three-round discussion in a team room

Desktop. Launch (lead Ada, members Cy and Di) linked to #sl5-room. A Slack kickoff opened a topic and Ada answered. `team-propose.ts --tool team_discussion` with rounds 3. Ticks every 20 seconds: after the third tick the discussion read done, round 3. The topic holds 6 member posts (Cy 3, Di 3) and the lead's posts. The question post reads "Participants: @di @cy" with "Assigned to Di, Cy". A second discussion showed the Stop discussion button; pressing it set the discussion to stopped and the button went away. Screenshots desktop-1 (finished topic), desktop-2 (second discussion running, Stop discussion visible, scrolled down), desktop-3 (after Stop).

Phone. New team Crew2 (lead Eve, Cy, Di), new topic "plan", the same steps. Done at round 3 with Cy 3 and Di 3 posts, Participants line shown. A second discussion showed Stop discussion and stopped. Screenshots phone-1 and phone-19 (finished topic), phone-2 (running, Stop), phone-3 (stopped). No horizontal scroll.

## Flow 2: decision queue of four questions

Desktop. Ada raised four questions (Date, Who, Channel, Budget with free text). The Slack message had eight buttons. I clicked Tue and Ada in the fake Slack: the message redrew with "Answer: Tue" and "Answer: Ada". The room card read "2 of 4 answered" with Tue and Ada pressed. On the web I chose Slack and typed "Mid, 5k": "4 of 4 answered", Send answers enabled, then sent. The Slack message settled as "... Answered on the web" with no buttons. Ada got a follow-up message with one line per answer (Date?: Tue, Who?: Ada, Channel?: Slack, Budget?: Mid, 5k). The card showed in the Needs you panel and at /desk?item=... with Send answers and Dismiss. Dismiss removed it and the Slack message settled as "Cancelled". Raising the same questions while a card is open returns the same card (the tool says "Raised 4 decisions (request ...)" with the old id); after Dismiss it gave a new card and a new Slack message with buttons. Screenshots desktop-4 (2 of 4), desktop-5 (4 of 4), desktop-6 (after Send), desktop-7 (Needs you panel), desktop-8 (card in Needs you), desktop-9 (after Dismiss), desktop-10 (raised again).

Phone. On Crew (Slack-linked after flow 4 set-up, lead Ada), a fresh topic "Phone kickoff: plan the offsite" and new questions (Venue, Catering, Start, Guests). Slack answers Harbour and 10am showed as "2 of 4 answered" on the web. I answered Catering and the free-text Guests on the web: "4 of 4 answered", Send answers, Slack settled as "Answered on the web", the lead got four answer lines. Dismiss in the Needs you card ("Cancelled" in Slack) and raising again gave a new card (new request id, new Slack message). The first dismissal I made on the phone hit an older card from Launch by mistake, so I redid it on the right one. Screenshots phone-4 (2 of 4), phone-5 (4 of 4), phone-6 (after Send), phone-7 (Needs you panel), phone-8 (card in Needs you), phone-9 (after Dismiss), phone-10 (raised again).

## Flow 3: team dream with a seeded conflict

Desktop. Workspace key saved on Home. On the Knows tab Ada got "Tuesday 8 December at 9am" and Cy "Thursday 10 December at 9am" (Work in progress, Shares with team on). Team Crew made with New team (Ada lead, Cy, Di). `dream.runTeamNow` from the browser console on Crew: one question, diary "1 question for the team owner: members' notes disagree." The question reached Needs you as "Ada has a question from its dream", held by Ada and Cy, two "Keep this one" buttons. I kept Tuesday: Ada's and Cy's notes both read Tuesday 8 December (Cy's Learned this week shows "Changed a note to"). Hand-off: Crew2 (lead Eve) with four room posts of the same rework, dream run: the diary has "Hand-off: ... The lead was asked to propose a change.", the "Team diary" topic holds the hand-off post (as the team owner, with the team_propose_change instruction) and Eve answered there. No lead: Crew3 (Cy, Di) with the same four posts: the dream diary has the "Hand-off:" line and no Team diary topic exists. Screenshots desktop-11 (Ada's note), desktop-13 (the question), desktop-15 (Cy's notes after Keep), desktop-16 (Crew2 Team diary), desktop-17 (Crew3 room, no Team diary).

Phone. New fake agent Fay. Cy got "The offsite venue is the Harbour room." and Di "The offsite venue is the Hills lodge." Teams Orchard (Cy, Di, no lead) and Meadow (lead Fay, Cy, Di) made on the phone, each with four rework posts. Orchard dream: question "Di has a question from its dream" (held by Cy and Di), Keep this one on Harbour: both notes agree. Orchard has no Team diary topic (the topic list shows only "Rework log"). Meadow dream: Team diary topic with the hand-off post and Fay's answer. Screenshots phone-11 (Cy's note added), phone-12 (New team sheet), phone-14 (question), phone-15 (after Keep), phone-16 (Di's notes agree), phone-17 (Orchard topics, no Team diary), phone-18 (Meadow Team diary).

## Flow 4: diary at 08:00

Launch unlinked, Crew linked to #sl5-room. Timezone set in Settings, Timezone (no console call needed) to Asia/Karachi, so 08:00 is 03:00 UTC. At 03:01:02 UTC I called the tick once. Result: the Team diary topic of Crew got Ada's diary post ("Read the shared notes of Ada, Di and Cy. 1 question for the team owner..."), and the fake Slack channel got the same text as a message from Ada. Crew2's diary went to its Team diary topic as Eve. Crew3 (no lead) got it as the team owner (author kind user, shown "Teammate"), not as an agent. The phone pass was the second size: the same room at 1280x800 reads the same. Screenshots desktop-18 (timezone saved), desktop-19 (Crew Team diary at desktop), desktop-20 (fake Slack channel, bottom), phone-13 (Crew Team diary at phone, taken right after the tick).

## Notes on "How to run it again" and things seen

- The list works. Missing: the dispatcher's step 3 lead tool uses the lead's newest room run in any team, so after Crew took the Slack link Ada had to be woken in Crew first (a Slack message in the channel does it) before `ask_decisions` landed in Crew. Also the key is typed on Home (a field shows until a key exists), not only Settings.
- I ran vite with `PUBLIC_BASE_URL=http://localhost:5301` over the .env.local value (port 3917). Nothing in the notes says to.
- The Launch team's lead Ada had two checkpoint wakes refused (`inbox.loop_stopped`, reason refused, "Run cannot be claimed") while team-propose.ts held her run in running state. The discussion still reached done. It looks like an effect of the helper (it marks the run running for eight seconds), not of the product.
- TX.9 confirmed: dream questions read "Ada/Di has a question from its dream", a member's name, not the team.
- Eve used all 10 wakes of the hour before the phone passes ended (TX.8 again), so the phone hand-off used a new lead, Fay.
- Cost: about $0.004 of model spend for the six team dreams.
- No Clerk users added, no product code changed, git untouched.

## Dispatcher ruling

The verdict above is the verifier's, kept as written. The dispatcher reads the failures as noise from the walkthrough tools, not from the app: every 500 names "database is locked" or came in the same minute as a script write or a `sqlite3` read of the verifier's own, and the control run was clean. The first TM walkthrough (`docs/reviews/TM-e2e.md`) met the same errors and ruled the same way. The controller can ask for a rerun with the tools kept off the file. TX-e2e.md "Things to know" now says how.
