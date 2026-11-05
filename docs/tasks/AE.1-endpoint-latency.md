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
