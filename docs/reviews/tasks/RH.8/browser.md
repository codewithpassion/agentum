# RH.8 browser verification

Worktree RH.8, commit 25c97eb5. Dev server on port 3258, dev login, browser session rh8-verify (chrome-headless-shell), desktop 1280x800 and phone 390x844. Tile values were read from the DOM with `[data-testid="agent-tile"]` (glyph, `bg-*` class, computed colour).

## Setup notes

- Seeded the dev workspace and "Fake echo" with `scripts/dev/seed-fake-agent.ts` after the first dev login.
- The builder only offers a runtime when a machine or an Anthropic key exists. I enrolled a machine with `scripts/dev/enroll-token.ts` and ran `scripts/dev/fake-daemon.ts --echo`, and for the phone pass chose "Cloud" with the Anthropic key from `apps/web/.env.local`, entered through Settings, Model providers (removed again at the end).
- Needs you: the fake runtime cannot ask for anything. I used a scratch script in `tmp/RH.8/ask.ts` that posts an approval request to the app's own `/api/machines/runs/<id>/requests` endpoint with the machine credential, for a queued Lunch Planner run. No DB writes by hand.
- Receipt: it only renders in the builder's dry run (`/tasks/<runId>` redirects to the thread page, which has no receipt). The dry run runs on the Cloud runtime, which cannot start locally ("Network connection lost" reaching the MCP server, also with PUBLIC_BASE_URL pointed at this server). Every dry run ended after 2 minutes with a "Run failed" step, so the receipt's agent step was exercised in that failed state, not in a successful run.

## Observations

Colours: Fake echo (seeded) is `F` on `bg-blue-600` (oklch 0.546 0.245 262.88). Lunch Planner, Lunch Planner Mobile and the other two-word names are `L` on `bg-emerald-600` (oklch 0.596 0.145 163.23). Never "LP".

1. Builder to home to room. Draft card for "Lunch Planner" (template loaded, name typed): `L`, bg-emerald-600, 52px. After Create, the room header: `L`, bg-emerald-600, 52px. Home card: `L`, bg-emerald-600, 40px. All identical, desktop and phone (phone agent "Lunch Planner Mobile").
2. Room header matches the home card for both agents (Fake echo `F` blue, Lunch Planner `L` green).
3. Needs you: Desk Needs you card ("Lunch Planner asks for approval") `L` bg-emerald-600 32px; top bar drawer row `L` bg-emerald-600 18px. Both match the home card, desktop and phone. Home card also shows the Needs you badge.
4. Receipt (builder dry run): Trigger step has no agent tile; the "Run failed" step shows `L` bg-emerald-600 32px, matching the draft card. Desktop and phone. See the receipt note above.
5. Desk board: Running ("second lunch task while offline", Waiting to start) `L` green; Done ("plan friday lunch") `L` green; Done ("hello please echo") `F` blue. All match the agent's home card, both sizes.

## Results

| Flow | Desktop | Phone |
|---|---|---|
| 1 Draft, home, room tiles match | pass | pass |
| 2 Room header matches home | pass | pass |
| 3 Needs you drawer row and Desk card | pass | pass |
| 4 Receipt agent step | pass (failed-run step only) | pass (failed-run step only) |
| 5 Desk Running and Done | pass | pass |
| Two-word name shows L on green | pass | pass |

Screenshots: desktop-1 draft card, 2 room header, 3 home, 4 Needs you drawer, 5 Desk board (Needs you, Running, Done), 6 receipt. phone-1 to phone-6 are the same views in the same order.

## Console and network

- A clean pass at both sizes over home, both rooms, the Desk board and the drawer (console cleared first): no console errors, no failed resource loads.
- Earlier in the session the console held errors that are not from RH.8: 38 forwarded server logs of `PiRun: ... Network connection lost` (the Cloud runtime cannot reach the local MCP server, which is why the dry run fails), 15 `ERR_CONNECTION_REFUSED` and 2 `ERR_INCOMPLETE_CHUNKED_ENCODING` while I restarted the dev server (I restarted it once to try a different PUBLIC_BASE_URL). The network log tool does not print status codes, so I read failed requests from the console only. No favicon issue showed.

## Limits

- The dry run could not finish successfully, so the receipt's normal agent steps (reply, tool calls) were not seen, only the failed-run step with the agent tile.
- Needs you was exercised with an approval only, not a question.

Verdict: pass. Every tile matched the stored avatar at both sizes and no error came from the change. Reservations: the receipt was verified on a failed dry run because the Cloud runtime cannot start locally, and the session console carried environment errors from that failed start and from my dev-server restart.

## Round 2: Map and question card (b6cddf67)

Worktree RH.8, commit b6cddf67. Dev server on port 3259, browser session rh8-verify2 (chrome-headless-shell), desktop 1280x800 and phone 390x844. Tile values come from `[data-testid="agent-tile"]` in the DOM (glyph and computed background). The local D1 from round 1 was reused: Lunch Planner, Lunch Planner Mobile and Fake echo already existed, so no agent was created this round.

### Steps

1. Signed in by opening `/api/dev-login` directly (the `/login` page did not show the "Dev login (local only)" link in this headless session; the API route is what the link hits). It redirected through `/dev-login` to `/home`.
2. /home: three agent tiles. Lunch Planner `L` oklch(0.596 0.145 163.225) (bg-emerald-600), Fake echo `F` oklch(0.546 0.245 262.881) (bg-blue-600), Lunch Planner Mobile `L` emerald. All 40px.
3. M1, /map: three agent nodes, each with an `agent-tile` (32px): Fake echo `F` blue, Lunch Planner `L` emerald, Lunch Planner Mobile `L` emerald. Never "LP". The two trigger nodes (orange `@` tiles) and two output nodes (cyan `@` tiles) keep their own glyph tiles. Same colours and glyphs as the /home cards.
4. M2: clicked each node and read the inspector (`aside`). Lunch Planner: `agent-tile` `L` emerald 32px. Fake echo: `agent-tile` `F` blue 32px. Trigger node `lunch-planner@agents...`: no agent-tile, a `bg-muted` tile (rgb(42, 42, 42)) with `L` (first letter of its name). Output node "Outbound email": muted tile with `O`. As expected.
5. N: I opened a question through the app's own machine endpoint, `POST /api/machines/runs/<runId>/requests` with `kind: "question"` and one question ("Which day should I book lunch for?", choices Thursday and Friday), using the machine credential from round 1 (`tmp/RH.8/ask2.ts`) on the queued Lunch Planner run "second lunch task while offline". The claim call returned 409 (already claimed in round 1, expected); the request call returned 200, status pending, deferred true. No DB writes by hand.
6. N, Desk board (`/desk?view=board`): Needs you lane holds the earlier approval card and the new question card ("Lunch Planner asks", "Answer question", header "Lunch day"). Both card tiles are `L` emerald 32px. The top bar badge went from 1 to 2.
7. N, Needs you drawer: two rows, "Lunch Planner asks before bash" and "Lunch day" ("Lunch Planner asks"). Both row tiles are `L` emerald 18px. Matches the home card.
8. Repeated 2 to 7 at 390x844. Same values at every point (home 40px, map nodes 32px, inspector 32px, Desk cards 32px, drawer rows 18px). On the phone the inspector opens as a panel under the map; the Map shows all seven nodes.

### Results

| Flow | Desktop | Phone |
|---|---|---|
| M1 Map agent nodes draw stored glyph and colour, match /home | pass | pass |
| M2 Inspector: agent tile matches; trigger and output keep muted first-letter tile | pass | pass |
| N Question card: drawer row and Desk Needs you card match home avatar | pass | pass |
| Fake echo and Lunch Planner tiles consistent between Map and /home | pass | pass |

Screenshots: desktop-7 home, 8 map, 9 map with Lunch Planner selected, 10 trigger inspector, 11 Desk board with the question card in the Needs you lane, 12 Needs you drawer, 13 Desk board scrolled to the question card. phone-7 home, 8 map, 9 Lunch Planner inspector, 10 trigger inspector, 11 Desk board, 12 Desk scrolled to the question card and lanes, 13 Needs you drawer.

### Console and network

- Clean pass at both sizes over /home, /map (all node clicks), /desk?view=board and the drawer, console cleared first: no errors, no warnings beyond the known Clerk development-keys notice, the software WebGL notice and Vite debug lines. The request log tool prints no status codes, so failed requests are read from the console (Chrome logs every failed resource load there); none appeared.
- One console error appeared earlier in the desktop session: `Failed to load resource: the server responded with a status of 400`. It came during the sign-in steps (the `/login` visit and the `/api/dev-login` redirect), before any page under test loaded, and did not recur on any later load. It is not tied to the avatar change but I did not trace which request it was. No favicon error was seen.
- No dev-server restarts this round.

### Limits

- The question was opened through the machine endpoint, not by a running agent, and I did not answer it, so the answered state was not exercised.

Round 2 verdict: pass. The Map agent nodes, the inspector header, the Needs you question card on the Desk and the drawer row all draw the stored glyph and colour at both sizes, matching /home, with no console errors on the tested pages. The one 400 seen during sign-in is noted above.
