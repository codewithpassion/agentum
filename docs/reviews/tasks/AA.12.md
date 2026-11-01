# AA.12 review record

Gate 1: card refresh gets a caller, and peer-run tool cards lose Always allow. Branch `task/AA.12-card-refresh`.

## Verdicts

- Round 1, at d7403544: not clean, 3 must-fix. A card fetch that failed left its row the oldest, so twenty dead peers filled the daily batch for good and each was retried every minute. The Slack approval card and the held-mail card on `/desk` still offered Always allow on a peer-rooted run. Fixed in 7c9c833a. The batch now marks each row as tried before its fetch (`peer_card_tried_at`, migration 0038), a peer that stays down waits an hour, and the order has an id tie-break. Both cards take `peerRun` through.
- Round 2, at 7c9c833a (fix commit only): clean, 7 nits.

`bun run check`, `bun run test` and `bun run build` pass, with no `drizzle` in `apps/web/dist/client`. The one test failure in the first full run was the known `guest execution: HTTP cap/start...` timeout. It passes alone.

## What changed

M4: the `refreshCard` tRPC procedure, a Refresh button on the page of an `a2a_outbound` connection that has not ended, and the tick job `a2a.card-refresh`, which calls `connections.refreshDue`. It takes up to 20 active outbound connections whose card is a day old or never fetched, oldest first. The `refreshCard` write now also matches the stored `peerCard` (the AA.2 round 5 nit). `desk.railSources` listing a moved card has a test in `needs-you.test.ts`.

N11: the approval display carries `peerRun: true` when the run is peer-rooted, and the web card, the Slack card and the held-mail card leave out Always allow.

One deviation from the finding's text. M4 said a failed fetch "changes nothing", and that stays true for the card, its fetch time and the status. The tick does write `peer_card_tried_at` before each fetch, which is what keeps a dead peer from being retried every minute and from starving the rest.

## Nits left

- `refreshDue` starts all fetches of a batch together. Cloudflare queues connections past six per invocation, and the 15 s timeout starts at call time, so six or more black-holed peers can make queued fetches time out untried. Their rows are marked tried, so they wait an hour. Credentials stay safe. Chunk the batch by six if it shows up.
- The failure log carries the connection id now, but the reason alone may not say which peer when it is only a status.
- `card-view.tsx` passes `offerAlways` true when the request has not loaded, so a held-mail card with no loaded request still offers Always send.
- No test covers `cardOf` in `slack/requests.ts` passing `peerRun` through, or `card-view.tsx` passing `offerAlways`. No render test covers the Always allow button in `request-card.tsx`; the logic is tested through `offersAlwaysAllow`.
- No test covers two overlapping ticks fetching one card once. The claim is one UPDATE with the due predicate in its WHERE, and it ran on `bun:sqlite` only, not on D1.
- A refresh whose write lost a race still counts as succeeded in the number `refreshDue` returns. Nothing reads it.
- The router test for a missing session shows `workspaceProcedure` answering 401. The refusal of a non-session principal is covered by the service test.

## Ideas beyond the scope

- A server-side guard against `always_allow` on a `peerRun` request in `requests.answer`. `desk.decide` with `always` (`desk-api.ts`) and Slack cards posted before this change still write the rule. The cards no longer offer it, so this only matters for old cards and direct callers.
- Mark a peer that fails several days in a row, so the connection page can say the card cannot be fetched.

## For Dom

Migration 0038 adds one nullable column. `wrangler d1 migrations apply DB --remote` applies it when the controller deploys.
