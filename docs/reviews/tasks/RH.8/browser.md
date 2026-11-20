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
