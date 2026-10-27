# B.11 review: live-call limits, refusal logging, staging deploy

## What changed

1. Flood guard (scope item 1). Option chosen: raise the guard above the service limits. `POST /api/share/:token/call` and `/storage` now use a new rate-limit binding `SHARE_CALL_LIMIT` (120 a minute per key, one key per token hash and one per IP prefix, namespaces 2007, 2008, 2009 for production, staging and previews). Opens keep `SHARE_OPEN_LIMIT` at 30. With the guard at 120, the service's own limits decide: 60 a minute and 1,000 a day per link, 10 a minute per visitor. Storage reads share the new binding under their own `storage:` prefix, so their only cap went from 30 to 120 a minute (they have no service limit and write no rows).
2. Refusals before the service write rows (scope item 2). `recordRefusedCall` in `packages/services/src/artifacts/shares.ts` writes a `live_call` row for a known link: `rate_limited` for a flood guard refusal, `refused` for a body that is not a call, and the link's own outcome (`revoked`, `expired`, `disabled`) when the link is dead. The tool key is null on these rows, because the guard answers before the body is read and a bad body has no valid tool. An unknown token writes nothing and answers as before (429 over the guard, 400 for a bad body, 404 otherwise). `rate_limited` rows do not count toward the limits; `refused` rows do, as a refused tool already did.
3. Deviation from "every refusal writes a row" (decided in review round 1). A guard refusal is a flood, and a row per refused request would turn the guard into unbounded D1 reads and inserts. Guard-refusal rows are capped with a second count (`calllog:` keys on `SHARE_CALL_LIMIT`, 120 a minute per token and per IP prefix). Past that, refusals are not logged. A failed log write is logged and does not change the answer.

## Verdicts

Round 1 (021f7e3c): must-fix. One item: a guard refusal on a known token did about three D1 reads and an insert with no cap, so past 120 a minute the guard no longer protected D1. Fixed in 2f34285e with the `calllog` cap above. Nits taken: dropped the unused `tool` parameter, dropped the `viewKey` check in `recordRefusedCall` (`callLink` never had it), the route no longer turns a failed log write into a 500, renamed and extended the limit-counting test, reworded the wrangler comments.

Round 2 (2f34285e, fix commit only): clean.

## Nits left

No test for the catch in `recordRefused` (a failing log write still answers 429 or 400). The `logged <= 2` in the cap test depends on two limiter calls per request (token and IP). The wrangler comments are wrapped unevenly. The refusal row is awaited before the 429 goes out; `waitUntil` would answer sooner. Bad-body `refused` rows count toward the per-visitor, per-link and daily limits, so a link holder can use up the daily budget with junk bodies (up to the guard's 120 a minute). A distributed flood of random `hm_share_` tokens from many IP prefixes still costs one hashed lookup per request, the same as before the guard trips.

## Checks

`bun run check`, `bun run test` (all packages, 0 fail) and `bun run build` pass at 2f34285e. New tests: `live-links.test.ts` (rows for guard and bad-body refusals, dead-link outcomes, unknown tokens, counting) and `artifacts.test.ts` (own guard binding, the service's 60 a minute deciding with the guard at 120, rows for guard refusals and bad bodies, dead link outcome, unknown token, the cap).

## Staging

Deployed from 2f34285e with `bun run staging:build`, then `bun run staging:deploy` in `apps/web`. The built `dist/server/wrangler.json` named the Worker `harbourmaster-staging`, the one route `harbourmaster-staging.rockyshoreslabs.io` (custom domain), D1 `harbourmaster-staging`, R2 `harbourmaster-staging-files`, rate limits `SHARE_OPEN_LIMIT` (2002), `SHARE_CALL_LIMIT` (2008) and `APP_API_LIMIT` (2005), and `"crons":[]`. The first deploy attempt stopped at the remote migrations step with Cloudflare API error 7403 (account not authorized for the D1 query) and nothing was uploaded; a read-only `wrangler d1 migrations list` then worked, and the same `bun run staging:deploy` passed on the second run (no new migrations; Version ID a5137fa2-9ab6-44ce-ac77-51263d029878, no cron schedule in the deploy output). Production was not touched and no secret was set. The Worker now has the `SHARE_CALL_LIMIT` binding (120 requests/60s).

Not run, blocked: the three checks on staging (restricted preview of a proposed app version, a live call over the limit answering `rate_limited` with a row in the access log, one `artifact_test` with no beacon error). They need a staging session, and `bun run agent-login --env staging` stops with "Staging and production need CLERK_SECRET_KEY in apps/web/.env.production.local or in the process environment". That file is not in this worktree, and the permission system refused my look for it elsewhere, so I did not go further.

## Steps for Dom

1. Run the three staging checks. Sign in with `cd apps/web && bun run agent-login --env staging --email dominik.fretz@harbouredgeintelligence.com` (with the staging `CLERK_SECRET_KEY` in `apps/web/.env.production.local`), or sign in by hand at https://harbourmaster-staging.rockyshoreslabs.io, or hand me the key file path to copy. Use new apps prefixed "B11"; leave the "A11" and "B10" data alone.
   - Restricted preview: have an agent create an app with a tool grant (it stays `proposed`), then open `/a/<id>?v=1` as the owner. The page renders, and its storage writes and tool calls answer as refused.
   - Over the limit: approve the grant, make a live link in the share dialog, then `curl -s -o /dev/null -w "%{http_code}\n" -X POST -H 'content-type: application/json' -d '{"tool":"<tool key>"}' https://harbourmaster-staging.rockyshoreslabs.io/api/share/<token>/call` twelve times from one machine. The 11th should answer 429 (10 a minute per visitor) and the access log (Share dialog, or `artifacts.views`) should hold a `live_call` row with outcome `rate_limited`.
   - `artifact_test` on a new app: no console error and no failed request in its report.
2. The production wrangler config now has `SHARE_CALL_LIMIT` (namespace 2007). It takes effect at the next production deploy, which is yours.

## Ideas beyond scope

A test that reads `wrangler.jsonc` and asserts the call guard limit stays above the service limits. A tool key on guard-refusal rows would need the body read before the guard.
