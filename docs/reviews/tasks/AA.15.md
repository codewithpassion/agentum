# AA.15 review record

Branch `task/AA.15-card-text-and-sweep`. Reviewed at a9a1ca13.

## Verdicts

Round 0, a9a1ca13: clean, no must-fix, 7 nits. No fix rounds.

## What was built

- M1: `listPeers` returns a peer's card description inside the peer envelope (`from.kind` peer), for every run. The `refreshCard` comment now says it replaces the card's text. The spec's "What the agent sees" says card text is peer text. No page change was needed: no page shows a stored peer description. The add dialog shows a freshly fetched card, which the person is reviewing.
- N5: migration 0039 adds the partial index `runs_live_status_idx` on live statuses. The sweep's unscoped chain query writes its statuses as literals so SQLite uses the index (bound parameters give a full scan). `tasks-revoke.test.ts` checks the plan with `EXPLAIN QUERY PLAN`, `schema.test.ts` checks the index and the `events` triggers after the migration. `LIVE_RUN_STATUSES` moved to `@repo/db/shared` so the index and the query share one list.
- N8: `listPeers` returns nothing for a managed agent's run.
- N7: `requests.answer` refuses `always_allow` on a peer-rooted run before it writes anything, so `desk.decide` can't write the rule. `card-view.tsx` offers Always send only once the request has loaded.
- N2, N6, N9: spec lines and the policies panel text.

## Decision: no skip of the sweep's chain query

The task asked to skip the query when no connection has ended since the last check, "if that's simple". It isn't, and it isn't safe. The revoke leaves work for the sweep (5 rounds of 50, a caught failure, a child started after the last cancel), so the sweep must keep scanning after the last connection ended. A skip needs state across isolates, and a decline writes no timestamp. "Does any ended connection exist" stops helping after the first revoke. The partial index makes the query cost follow live runs instead of all runs, which is the N5 problem.

## Nits left

- `errors.ts:31` still says "hourly limit of tasks" in the 429 message.
- `mail-decision.tsx` still defaults `offerAlways` to true. Its one caller now always passes it.
- `list_agents` text in `packages/mcp/src/tools/agents.ts` JSON-quotes the description, which is now an envelope, so it arrives escaped with the notice repeated per peer. It stays labelled and safe.
- `peers.test.ts` in `packages/mcp` still uses a plain-text description fixture.

## Beyond the scope

- Nothing proved the plan on D1, only `bun:sqlite`. SQLite's partial index rules are the same.

## For Dom

Migration 0039 needs `wrangler d1 migrations apply DB --remote` before the next production deploy.
