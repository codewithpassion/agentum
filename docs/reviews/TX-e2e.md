# TX end-to-end: the team extras walkthrough

Task TX.7. Verdict: the three team extras work on local. A lead ran a three-round discussion in a team room, raised a four-question decision queue that was answered half in the web app and half in the fake Slack, and a team dream settled a seeded conflict between two members. Every step in the scope worked. Five things around the edges did not, and are listed below with proposed tasks. The browser proof, step by step with screenshots at 1280x800 and 390x844, is `docs/reviews/tasks/TX.7/browser.md`.

## What was real and what was not

- The agents were fake-runtime agents (`bun scripts/dev/seed-fake-agent.ts <slug> <name>`) and the three Slack apps of `seed-slack-room.ts`. The fake runtime echoes its input and cannot call tools, so the lead's tool calls came from `scripts/dev/team-propose.ts --tool <name> --args <json>`. It signs a run token for the lead's newest room run and calls the real `/mcp` route, so the tools (`team_discussion`, `ask_decisions`, `team_propose_change`), the services and the Slack card code are the real ones. Nobody wrote a team discussion or a decision queue straight into the database.
- The team dream used the real model (`claude-haiku-5-5`) with a workspace key saved through Settings from a shell variable into the local database. The five team dreams of this walkthrough cost $0.0035 together (a dream over three members' notes and a few room posts costs about $0.001). The key appears nowhere in the repo or here.
- The minute tick does not run under `vite dev`. A discussion advances only on the tick (a round ends, the lead checkpoint runs, the next round opens), so the walkthrough calls it by hand: `curl "http://localhost:<port>/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"`. It answers `ok` when the jobs have finished.
- The app has no button for a team dream, so `dream.runTeamNow` was called from the browser console, signed in as the team owner: `fetch('/api/trpc/dream.runTeamNow', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({teamId})})`.
- The workspace timezone is UTC, so the 08:00 diary slot is hours away. The walkthrough set it with `workspaces.setTimezone` to `Asia/Dhaka` (08:00 there is 02:00 UTC), ran a dream before the slot, and ran the tick after it.

## Result by step

| Step | Result |
|---|---|
| Discussion, three rounds, lead plus two members | The lead's question post names the participants. Cy and Di each posted once per round, six member posts in all and no more. The lead checkpoint ran after each round and its reply opened the next round, the last reply closed it. The discussion ended `done` at round 3. |
| Stop a running discussion | The Stop discussion button appears in the room while it runs and the discussion went to `stopped`. The button is gone afterwards. |
| Decision queue of four questions, raised by the lead | One card in the room, in Needs you and in the fake Slack thread as one message with a button row per question. |
| Two answers in Slack | The Slack message redrew with "Answer: ..." under each. The web card then read "2 of 4 answered". |
| Two answers on the web, Send answers | "4 of 4 answered". The Slack message settled as "Answered on the web". The lead's follow-up run started with one line per question, in order. |
| Dismiss and raise again | Dismiss hid the card. The same questions raised again gave a fresh card and a fresh Slack message. |
| Team dream with a seeded conflict | Ada and Cy each held a note on when the announcement goes out (Tuesday 8 December, Thursday 10 December). The dream made one question for the team owner, held by Ada and Cy, in Needs you. Keep this one closed it, and Cy's note then read Tuesday 8 December. |
| Dream finding that needs a member change, team with a lead | Four room posts told of the same rework (Di re-formatting Cy's dates). The dream wrote the finding in the "Team diary" topic as the team owner, and the lead (Eve) woke and answered there. `team-propose.ts` then had the lead raise `team_propose_change` and the member's owner got the request. |
| Same, team with no lead | The dream ran with no lead and posted nothing at dream time. |
| Diary at 08:00 | After the slot the tick posted each diary in the Team diary topic: as the lead in a team with a lead, as the system in a team with none. In the Slack-linked team the room-out path sent them to the channel as the lead's app. |

## Findings and proposed tasks

### TX.8 A hand-off wake that is refused is lost without a trace

Finding. The hand-off request is posted in the Team diary topic and the lead is woken. When the lead has used its 10 wakes for the hour, the wake is refused with an `inbox.loop_stopped` event (reason `budget`) and nobody ever tells the lead. The dream's own diary still says "The lead was asked to propose a change", and the Team diary post sits unanswered. It happened here after about ten fake-runtime posts in an hour. A real lead on a busy team could meet it too.

Scope. When the wake for a hand-off request is refused, retry it on a later tick (the hand-off post is the record: wake the lead when it has no run after the post and the budget allows). Word the diary line as "asked" only when the wake started.

Check. A service test with a lead at its wake limit: the post exists, no run starts, a later tick after the window starts it once. Browser: the lead answers in Team diary.

### TX.9 Team dream questions show a member's name

Finding. The question reaches Needs you as "Ada has a question from its dream" with Ada, a member, as the name. The question belongs to the team (its `agent_id` is null and its `team_id` is set), so it should name the team: "Crew has a question from its team dream". The desk draft (`packages/services/src/desk.ts`, `dreamQuestions`) fills `agentId` and the heading (`packages/db/src/shared.ts`, `NEEDS_YOU_HEADINGS.dream_question`) takes an agent name only.

Scope. Give the card a team name for a team question and pick the heading from it.

Check. A desk test with a team question, and the Needs you pane in the browser.

### TX.10 No place in the app to see or start a team dream

Finding. A team dream has no button, no card, no list of earlier dreams and no way to read the digest or the team's notes. The only traces are the Needs you question and the Team diary topic. `dream.runTeamNow`, `dream.get` and `dream.undo` exist and work for the owner.

Scope. A "Team memory" section on the team page for the owner: Dream now, the latest team dream's diary and counts, Undo, and the team's notes. Reuse the agent dream card (`components/agent/room/knows/dream/`).

Check. Component tests, then the browser at both sizes.

### TX.11 The seeded Launch team cannot dream

Finding. `scripts/dev/seed-slack-room.ts` writes the team rows directly and sets no `folder_path`, so `runTeamNow` answers "Launch has no team folder, so it keeps no team memory and does not dream". A team made in the UI gets `teams/<slug>` and works. The walkthrough made a second team ("Crew") in the UI for the dream.

Scope. Make the seed create the team through `teams.create` (or write the folder and its grants).

Check. A seed test that `runTeamNow` on the seeded team does not refuse.

### TX.12 One diary per dream, not one per night

Finding. Every team dream posts its own diary at the next 08:00. Four manual dreams on one day gave four diary posts in the Team diary topic and four messages in the Slack channel at once. Dreams run once a night in production, so this shows only after "Dream now" repeats. If a UI button arrives (TX.10), it would show up often.

Scope. At the 08:00 slot post only the newest dream's diary for the team, or join the day's diaries into one post.

Check. A tick test with two finished dreams for one team and one slot: one post.

## Fixed on this branch

- `scripts/dev/team-propose.ts` waits eight seconds before it puts the run back, because its write while the server posted a Slack card made the server's query fail with "database is locked", and the decision card then never reached Slack. With the pause the card posted every time.

## Nits left alone

- The first dream in a team that never dreamed reads every room post, including the lead's checkpoint echoes. Real runs are fewer, so nothing to do.
- The fake runtime echoes cascade: a lead's echo mentions members, and their echoes appear as Slack messages that start `Echo: Echo:`.
- `team-propose.ts` uses the lead's newest room run in any team. A lead that sits in two teams has to be woken in the right team first, or the tool refuses with "This credential may not do that".

## Things to know about running this walkthrough

- Start the dev server with `VITE_FAKE_SLACK_URL=http://127.0.0.1:<slack port>` on a free port, run `bun scripts/dev/fake-slack.ts --app-url http://localhost:<port> --port <slack port>`, sign in with `/api/dev-login`, and run `bun scripts/dev/seed-slack-room.ts`. This host needs `AGENT_BROWSER_EXECUTABLE_PATH=$HOME/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell`.
- Run the dev server and the fake Slack with the Bash tool's `run_in_background`. A server started with `nohup ... &` in one call dies when that call ends, and a background job stops after its timeout.
- An agent wakes at most 10 times an hour. A lead that runs a discussion, then answers room posts, can reach it, and a refused wake leaves only an `inbox.loop_stopped` event (finding TX.8). Seed another fake agent for a second pass.
- Do not run `sqlite3` or any script that writes the local database while the server posts a Slack card. The server logs "database is locked" and the card is lost.

## How to run it again

From the repo root, in this order. Ports here are examples.

1. `cd apps/web && bunx wrangler d1 migrations apply DB --local`, then `VITE_FAKE_SLACK_URL=http://127.0.0.1:5238 bunx vite dev --port 5237` in `apps/web`, and `bun scripts/dev/fake-slack.ts --app-url http://localhost:5237 --port 5238`.
2. Open `http://localhost:5237/api/dev-login`, then `bun scripts/dev/seed-slack-room.ts`. It makes the "Launch" team (lead Ada, members Cy and Di) and links no channel. On the team page pick `#sl5-room` and press Link channel. Invite the third app: `curl -XPOST localhost:5238/_membership -d '{"botUserId":"U0DILOCALBOT","member":true}'`.
3. Discussion. `curl -XPOST localhost:5238/_say -d '{"text":"Kickoff: plan the launch"}'` opens a topic and Ada answers. Read the topic id from the room URL or the database, then `bun scripts/dev/team-propose.ts --server http://localhost:5237 --lead ada --tool team_discussion --args '{"topic":"<topic id>","question":"Which date?","rounds":3}'`. Call the tick probe a few times, 20 seconds apart. Start another and press Stop discussion in the room.
4. Decisions. `bun scripts/dev/team-propose.ts --server http://localhost:5237 --lead ada --tool ask_decisions --args '{"questions":[{"text":"Date?","options":["Mon","Tue"]},{"text":"Who?","options":["Ada","Cy"]},{"text":"Channel?","options":["Email","Slack"]},{"text":"Budget?","options":["Low","High"],"freeText":true}]}'`. Click buttons in Slack with `curl -XPOST localhost:5238/_click -d '{"actionId":"<id from /_state>","ts":"<message ts>"}'` (or in the fake's own page at `http://localhost:5238/`), and answer the rest in the room.
5. Team dream. Save the workspace Anthropic key in Settings. On the Knows tab of Ada and Cy (Shares with team is on by default) add one note each that disagree. Make a team in the UI (New team, Ada as lead, Cy, Di). Call `dream.runTeamNow` from the console as above. Answer the question in Needs you. For the hand-off, post four room posts that each tell one case of the same rework, then run the dream again.
6. Diary. Set the timezone with `workspaces.setTimezone`, so 08:00 falls a few minutes ahead, wait, and call the tick probe.

## Steps for Dom

None need his accounts or dashboards. The staging check of the Slack decision card and the 08:00 diary with a real Slack workspace is the same as SL.5's staging list and waits for a staging deploy.
