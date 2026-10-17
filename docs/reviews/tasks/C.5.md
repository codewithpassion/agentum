# C.5 review

Task: MCP bridge hardening. Branch task/C.5-mcp-bridge.

## Verdicts

- Round 1 (7fcd31a): not clean, 1 must-fix, 10 nits.
- Fix round 1 (7fd0ff8), reviewed: clean, 0 must-fix, 6 nits.

The round 1 must-fix: a tool refresh read the servers from storage before it joined the sync queue, and a start stores them after it syncs. A refresh during a start could install the previous run's connectors over the new run's. Now the sync keeps the newest servers it was given in memory, and a refresh reads them when its turn in the queue comes.

## The premise was partly stale

The spike said a Pi session fixes its tools when it is created. On the pinned pi-durable 1.3.0 that is not true. `pi-registry-reinstall.test.ts` runs a real harness with the faux model: an extension installed in the registry after the conversation exists is callable on the next submission, and a removed one answers "Tool X is not available". So the bridge needs no new session. It only has to keep the registry equal to what the servers list now.

A POST-only MCP client cannot receive `notifications/tools/list_changed`, so "reconnect" means looking again at three moments:

- At the start of every run (this already happened, for new runs).
- After a wake of the Durable Object, if a run is active.
- After a tool call that fails at the transport or JSON-RPC level, at most once per 30 s. A tool that vanished shows up this way on `/mcp`. The call itself still fails to the model.

The registry is touched only for servers whose list changed, because every install makes Pi tell the model the tools changed. A server that cannot be listed keeps the tools it had (none the first time) and logs a warning. A run fails to start only when no server can be listed. That closes C.3 nit 10: one unreachable connector used to release the run, and the sweep offered it again every minute until it expired.

## Decision: in-process ports or a self service binding

Neither, for now. The Durable Object keeps fetching `/mcp` and `/api/proxy` over HTTP at `PUBLIC_BASE_URL`. No wrangler change, no compose change.

Why not in-process tool ports: `/mcp` would skip the run token check (signature, age, `running` with a live lease), and `/api/proxy` would need its credential resolution, SSRF guard and `connector.call` events built a second time. Two copies of the rules that decide what an agent may call is the wrong cost for saving a hop.

Why not a self service binding: the Cloudflare docs say a Worker on a Custom Domain can fetch another Worker on a Custom Domain in the same zone without a binding (routes and workers.dev cannot). Production and staging are both `custom_domain: true`. An explicit service binding means three places in `wrangler.jsonc` and a service name per preview. Previews set `PUBLIC_BASE_URL` to an empty string, so `compose` never builds the cloud adapter there anyway.

I tried the third option, a `ctx.exports` loopback (`this.ctx.exports.default.fetch(new Request(url, init))`, no config, typed by `wrangler types`). It works under `vite dev` with `PUBLIC_BASE_URL` pointing at a dead port, but only after setting `host` on the request, because the MCP handler's DNS rebinding check reads the Host header and a bare `Request` has none (the first try got 403). Whether the deployed runtime keeps a hand-set Host on a service binding call is not documented, so I did not adopt it.

The real verdict is the staging check below. If the self-fetch fails there (error 1042 or a 5xx from the fetch), switch to the loopback: in `pi-run.ts` make a `McpFetch` that sets `host` from the URL and calls `this.ctx.exports.default.fetch`, and pass it to `syncMcpTools` and `mcpToolRegistrations`. Check `enable_ctx_exports` is on (it is by default for the Worker's compatibility date).

## Checks

- `bun run check`, `bun run test` and `bun run build` pass at 7fd0ff8. The `drizzle` grep on `apps/web/dist/client` finds nothing.
- `scripts/e2e/cloud.ts` against `vite dev` passes all eight scenarios, including the `bash` call through `/mcp`.
- New `scripts/e2e/cloud-proxy.ts` passes against `vite dev` with the stub MCP server behind a cloudflared quick tunnel: a tool call through `/api/proxy`, a dead connector beside a working one (the run starts and `bash` answers), and the proxied tool answering beside the dead one. Run before the fix, scenario 2 hangs (the run never starts), so the check exercises the change.
- Bun tests: the helpers in `pi-run-mcp.test.ts`, the registry pin in `pi-registry-reinstall.test.ts`, the scenario logic in `cloud-proxy.test.ts`.
- To run the live scripts locally, `PUBLIC_BASE_URL=http://localhost:<port>` must be in `apps/web/.env.local`.

## Nits left

1. After a session's last run ends, storage drops the servers but `#servers` keeps them. A failing call then could trigger a refresh that lists with a dead run token and logs a warning per server. Lists survive, since failed servers keep their tools.
2. A second start of the same run stores a new token but skips the sync, so a refresh lists with the first claim's token. It works while tokens are checked by status and age only, and stops working after the 12 hour token limit if the run is still going.
3. A sync that throws (all servers down at a start) still leaves its servers in `#servers`.
4. A refresh that reads storage does not save the result in `#servers`.
5. The refresh fires on any `rpc` failure (network, 5xx, expired token, bad JSON), because `rpc` drops the JSON-RPC error code. The throttle bounds it.
6. The throttle counts a refresh that found no servers, so it can hold off a real one for 30 s.
7. The wake refresh runs only when `resume()` succeeds.
8. The harness factory's `#installTools` runs outside the `#syncing` queue. Storage ordering makes it safe in practice.
9. `#installed` is set after the install loop. If `registry.install` throws partway, the next sync reinstalls what is already there.
10. Comparing lists with `JSON.stringify` depends on key order. A server that reorders fields causes one needless reinstall.
11. An agent whose only server is down still cannot start.
12. No test covers the refresh path end to end (failed call, throttle, sync, reinstall, next call works). The Durable Object class has no unit test, and the ordering fix has none either.
13. `pi-run-faux.ts` treats any prompt starting with `call ` as a tool call. Dev builds only.

## Ideas beyond the scope

- Keep the JSON-RPC error code in `rpc` so the refresh fires on an unknown tool only.
- A `bun test` that loads `PiRun` under the `cloudflare:workers` shim, so ordering fixes like round 1's can be tested (C.3 and C.4 had the same idea).
- A stub MCP server mode whose tool list changes, to drive the refresh live.

## Steps for Dom and the controller

Nothing for accounts or dashboards. For the controller's staging deploy, the check that settles the decision above: on staging, start one cloud run whose agent calls `harbourmaster_bash` (the `/mcp` path) and one connector tool (the `/api/proxy` path), and confirm both return. The `faux` model is dev only and not in the deployed bundle, so this needs a workspace model key (C.6). Without a run, the only sign is `wrangler tail`: look for `mcp.request` lines with `via: run_token` for the run, and for a failed start in the log ("Starting cloud run ... failed"). If the fetch from the Durable Object to its own origin fails, apply the loopback described under the decision.
