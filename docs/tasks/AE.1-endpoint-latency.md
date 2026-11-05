---
id: AE.1
title: App endpoints answer before ctx.waitUntil work, and endpoint latency is measured
milestone: AE
size: M
status: in_progress
depends_on: []
branch: AE.1-endpoint-latency
lane: web
executor: codex
---

## Report (Dom's Discord bot session, 5 Nov 2026)

The CCAU Roles Discord bot on production (app artifact 7080eaad-e975-4ab7-9193-295edad3fed8, v4) changes the role every time, but Discord shows "The application did not respond" because it gets no HTTP answer within 3 s. v4 checks `typeof ctx.waitUntil === "function"` (true), returns `{ type: 5, data: { flags: 64 } }` at once, and does the role change and a follow-up PATCH inside `ctx.waitUntil`. Discord still times out. v3 did the work inline and took 2344 ms from the start of `fetch()` to Discord's 204, mostly one proxied call to discord.com (a proxy secret fills `Authorization: Bot {value}`). Saving the Interactions Endpoint URL failed once (Discord's PING) and worked on retry.

## What the controller measured

An unsigned POST to the production hook (the bot answers 401 from its own signature check, no Discord call) takes 0.10 to 0.14 s warm and 1.0 to 1.4 s on a cold start (2 of 11 requests). Warm platform overhead is small. So the likely cause is that the endpoint's answer waits for the app's `ctx.waitUntil` work.

How a call runs today: `mountEndpointRoutes` (`apps/web/src/server/app-gateway/endpoints.ts`) calls `handleEndpointRequest` (`gateway-core.ts`), which awaits `runApp`, which races `deps.runtime.handle(input)` against the wall timer. `dynamicAppRuntime.handle` (`dynamic-app-runtime.ts`) makes the RPC call `Harness.handle(request, host)` on the Dynamic Worker, and the harness (`HARNESS_SOURCE` in `modules.ts`) calls `app.fetch(request, env, this.ctx)`. The app's `ctx.waitUntil` is the Harness entrypoint's own `ctx`. Find out whether the RPC promise, and so the parent's response, settles only after that entrypoint's waitUntil work.

## Scope

1. **Reproduce first** in the real-workerd test (`real-worker.test.ts` with `real-worker-fixture.ts`, a real Worker Loader). Add an app whose `fetch` returns at once and registers `ctx.waitUntil` work that takes about 2.5 s. Measure the time to the endpoint's response, and confirm the waitUntil work still completes (for example it writes an item through `env.AGENTUM.setItem` that the test then reads back). Record the measured numbers in the Log below.
2. **Fix it so the response goes out as soon as the app's `fetch` resolves.** Work the app passes to `ctx.waitUntil` keeps running after the response and is not cancelled. Its outbound requests still go through `AppOutbound` with the same grants and secret filling. Keep it simple. One shape that keeps the Dynamic Worker alive: the harness hands the Response back through an RPC callback (a function stub the parent passes in) the moment `app.fetch` resolves, then waits for its own waitUntil promises before its RPC method returns; the parent answers on the callback and passes the rest of the RPC promise to its own `executionCtx.waitUntil`. Use a better one if you find one. Rejected or timed-out waitUntil work is recorded as an app error (`recordError`, entry `waitUntil <endpoint name>`) and never changes the response. Cap the background work at 30 s (the Workers waitUntil limit). The wall timer (`APP_WALL_MS`) applies to producing the response only. Apply the same to the page API path (`serve`) if it shares `runApp`, so `ctx.waitUntil` means the same everywhere.
3. **Measure latency.** Log one line per endpoint call with stage timings in ms, no values, no URLs beyond the endpoint name: limiter, resolve, meta, app response, total. Log one line per outbound app request: the grants read, the secret rules read, the upstream fetch, total. Use `console.log` with a fixed prefix (`app endpoint timing`, `app outbound timing`) so `wrangler tail` can filter. Measure cold against warm in the real-workerd test and record the numbers in the Log. If the outbound path does avoidable work per request (for example building all the services in `portsOf(env)` on every outbound call, or two database reads where one would do), fix it, provided approvals are still read on every request.
4. Update `docs/v3/app-endpoints.md`: the response leaves when `fetch` resolves, `ctx.waitUntil` work runs up to 30 s after it, and its failures appear as app errors.

Out of scope: a Discord fast path where the platform verifies signatures or auto-defers. Write in the Log whether you think it is still needed after the fix.

## Check
- The new real-workerd test fails before the fix (the response takes about 2.5 s) and passes after (well under 1 s), and the background work completes.
- `bun run check && bun run test && bun run build`, then the bundle grep for `drizzle` in `apps/web/dist/client`.

## Log

### 5 Nov 2026 — implementation and local measurements

- Added the real-workerd reproduction first, using the actual Worker Loader and
  a 2,500 ms `ctx.waitUntil` task that writes shared storage through AgentumHost.
  Before changing the runtime, response/body times were **4 ms cold, 1 ms warm,
  1 ms page API**; all three writes were present after 2,800 ms. Thus the
  suspected 2.5 s RPC blocking could **not** be reproduced on the installed
  workerd (1.20261012.1). The latency assertion already passed before the fix;
  inventing a failing baseline would misrepresent this result. The separately
  added background-error regression did fail before the fix: no `waitUntil
  discord` error was recorded.
- Implemented the explicit RPC response callback anyway, with the remaining RPC
  retained by the parent's waitUntil. The harness tracks app waitUntil promises,
  including work registered by other background work, and caps their lifetime
  at 30 seconds after fetch resolves. Failures/timeouts use recordError with
  `waitUntil <endpoint name>` / `waitUntil page`. The response wall timer only
  races the response callback. Both endpoint and page API paths use this.
- In the focused real-workerd run after the change, response/body times were
  **5 ms cold, 2 ms warm, 1 ms page API**. Endpoint timing lines for the cold
  and warm calls reported app response **4 / 0 ms**, total **4 / 0 ms**;
  limiter, resolution and metadata stages rounded to 0 ms. These use fake
  persistence ports, so they measure local Worker loading/RPC overhead, not
  production D1, R2, network or isolate eviction. Subsequent suite timings may
  vary under parallel test load.
- Verified background writes complete, rejected work preserves the 202 answer
  and records an app error, and the 30 s cap records a timeout and cancels a
  write scheduled for 31 s. A background outbound call received its proxy
  secret at the test upstream, while an unapproved host received 403.
  That outbound call measured grants **0 ms**, secret rules **0 ms**, upstream
  **2 ms**, total **4 ms** against the local stub upstream; no external Discord
  latency is represented by these numbers.
- Added one JSON timing line per endpoint/outbound call, including refusals,
  using `app endpoint timing` and `app outbound timing`. Timings contain only
  stage milliseconds and (for endpoints) the resolved endpoint name, null for
  an unresolved endpoint; no request URL, credentials, bodies or caller values.
- appGatewayPortsOf already caches composed ports per env; no service rebuild
  fix was needed. Combined the host and secret approval queries into one fresh
  D1 read per outbound request. Secret rule/value lookup remains after the host
  check, and no approvals are cached between requests.
- Updated app-endpoints.md with response/background lifetime and error behavior.
  No Discord verifier or auto-defer fast path was added. I would defer that
  feature pending deployed timing evidence: the explicit callback guarantees
  early answers, but these local results do not establish the production
  timeout's cause or prove that a production Discord call now meets 3 seconds.
- Final root validation: `bun run check && bun run test && bun run build`
  passed. Tests: **10,453 passed, 1 existing skip, 0 failed** (web: 4,242
  passed / 1 skipped; services: 4,000 passed; remaining package and root-script
  suites: 2,211 passed). The full-suite real-worker run measured **3 ms cold,
  1 ms warm, 1 ms page API**, with background writes completing. Its cutoff
  test passed in 32,017 ms, including the check that the 31 s write never ran.
  The client-bundle `drizzle` grep returned no matches. Build emitted chunk-size
  and CSS sourcemap warnings but completed, including check-dev-only.
