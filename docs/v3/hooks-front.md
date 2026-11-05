# Hooks front Worker

Status: requested by Dom on 5 Nov 2026. Task DF.2. This replaces the Discord-specific design (DF.1, stopped; its work is on branch `DF.1-discord-front`).

## Why

Callers such as Discord want an HTTP answer within a few seconds (Discord allows 3 s). An app endpoint runs in the main Worker (`agentum-v2`, 23.7 MB, about 490 ms of start-up CPU) and then in the app's Dynamic Worker. On staging on 5 Nov the handler took 73 to 1,099 ms, but the time seen from outside reached 3.8 s, because a cold main Worker starts before our code runs. A rarely used bot nearly always lands on a cold Worker. The CCAU Roles Discord bot on production times out even though its code answers `{ type: 5 }` at once.

## Decision (Dom, 5 Nov 2026)

Agentum stays protocol-neutral: the app answers its own caller, and Agentum learns nothing about Discord or any other protocol. The app's code runs in a small Worker that starts fast, and the main Worker is only reached for the services the app uses.

## Shape

- **Worker.** A new app, `apps/hooks`. Plain TypeScript, no framework, as few dependencies as possible, so its start-up stays near zero. Names: `agentum-v2-hooks` (production) and `agentum-v2-staging-hooks` (staging, `--env staging`).
- **Routing.** Routes `agentumbot.io/hooks/*` and `staging.agentumbot.io/hooks/*` (with `zone_name`). A route takes precedence over the main Worker's custom domain on the same hostname, so hook URLs don't change. The main Worker keeps its `/hooks` handler for previews and as a fallback.
- **Bindings.** `DB` (the same D1, reads only), `FILES` (the same R2 bucket, if the app bundle is read from it), `LOADER` (a Worker Loader), a rate limit binding if the main Worker's hook limits must move with it, and `MAIN`, a service binding to the main Worker.
- **Per request:**
  1. Rate limits as the main `/hooks` route does today (IP prefix buckets, then the endpoint bucket), before any database read.
  2. Resolve the endpoint and its live approved version, with the same rule as `resolveEndpoint`, in as few D1 queries as possible.
  3. Load the app's version as a Dynamic Worker in the front, with the same harness, limits and compatibility date as `dynamicAppRuntime`, cached by the loader under `app:<versionId>`. Reading the bundle on a cold start goes through the same storage the main Worker uses.
  4. Call the app's `fetch` and return its response, through the same response filtering and content headers as `handleEndpointRequest`, as soon as `fetch` resolves (the AE.1 callback shape). `ctx.waitUntil` work continues for up to 30 s under the front's own `waitUntil`.
- **What stays in the main Worker:** the app's `env.AGENTUM` (`startRun`, `callTool`, storage) and its outbound requests (approved hosts and secret filling). The front gives the Dynamic Worker an `AGENTUM` stub and a `globalOutbound` that forward to the main Worker over the service binding, carrying the request's identity (artifact, version, workspace, endpoint). Make it a named RPC entrypoint on the main Worker that only a service binding can reach, never a public route. Secrets never leave the main Worker. The main Worker only starts when the app first uses one of these.
- **Access log and errors.** Each call still writes its `live_call` row with status and duration, and app errors are still recorded. The front may write the row with a direct D1 insert, or send it to the main Worker in `waitUntil`. Either way the Endpoints tab must look the same.
- **Timing.** One line per request, `hooks front timing`: limiter, resolve, bundle (when cold), app response, total, in ms, with the endpoint name and nothing else.

## Gate

Measure first, before building the rest. In a real two-Worker Miniflare setup, a cold front call to an app that returns at once must answer well under 1 s, counting front start, lookup, bundle read and Dynamic Worker creation. If it doesn't, stop and report the numbers with what costs what.

## Docs

Update `docs/v3/app-endpoints.md`: endpoints answer from the hooks Worker. Keep the guidance protocol-neutral: an app that must answer fast returns at once and does slow work in `ctx.waitUntil`. The Discord example (`packages/mcp/src/tools/discord-example.ts`) should already follow that. Check it does.

## Code

The gateway code both Workers run is in `packages/app-gateway` (`@repo/app-gateway`): the Dynamic Worker runtime and harness, the endpoint handler, the bundle reader and the `HooksMain` definition (`hooks-rpc.ts`). `apps/hooks` imports only that package, `@repo/db` and `@repo/services`, never `apps/web`.

`HooksMain` trusts the props its caller sends, because only a Worker with a service binding to it can call it, and any Worker in the Cloudflare account can declare one. It refuses every viewer but `endpoint`, so a forged call can do no more than a request to `/hooks/<id>` could.

## Deploy

`apps/hooks` gets `deploy` and `staging:deploy` scripts. The controller deploys staging. Production needs Dom's go-ahead.

Order: deploy the main Worker with `HooksMain` first, then the hooks Worker. A main Worker rolled back to a version without `HooksMain` breaks every hook whose app uses `env.AGENTUM`, outbound requests or error recording, while plain answers keep working. Roll the hooks Worker back first, or delete its route so the main Worker's fallback `/hooks` handler serves again.
