# B.8 review: phase 2 wiring and bindings

Branch `task/B.8-phase2-wiring`.

## Verdicts

| Round | Commits | Verdict |
|---|---|---|
| 1 | 128ecb7c, merge 8512191f | must-fix: platform-side error text (D1, Clerk) crossed RPC to app code on both call paths; no flood guard on `/a/<uuid>/c/<token>/api/*`; the no-secret outbound path followed redirects past the host allowlist; a `<tool>#<json>` limits target could be named as a tool |
| 2 | 8512191f..f0bf1db4 | clean |

The reviewer's fifth must-fix (no record of a local round trip) is answered below.

## What was built

- Route `/a/<uuid>/c/<token>/api/*` (`app-gateway/mount.ts`), mounted before the content routes. It verifies the view token, checks the path uuid equals `claims.artifactId`, refuses snapshot-link and test viewers on versions that declare hosts, counts link holders against `APP_API_LIMIT` (300 a minute per link and per IP prefix, members not counted), and passes every answer through `withContentHeaders` plus `no-store`.
- `app-gateway/compose-ports.ts` fills `AppGatewayPorts` from the composed services: bundle from the R2 manifest (`server/` files, `declaresHosts` from the grant rows), member calls (a rebuilt session principal after an uncached Clerk membership check), link calls by share id, grants port, shares port, `canWrite`, the `AppStore` port. `wiring.ts` builds it per request (route) or once per `env` (entrypoints). `app-entrypoints.ts` exports `AppHost` and `AppOutbound`; `server.ts` also exports `AppStore`.
- `wrangler.jsonc`: `APP_STORE` binding and `APP_API_LIMIT` rate limit in three places, the `v7` `AppStore` migration at the top level. `wrangler types` regenerated.
- Services: `arg-limits.ts` enforces `<tool>#<json>` rows on member calls and live calls (fail closed: a limited argument must be present and inside its bounds, and a limits row that is not approved refuses). `shareState`, `visitorMeta` and `callShare` (by share id, one inner function shared with `callLink`). `app-grants.ts` (approved hosts, secret rules by name, `memberPrincipal`), `secrets.proxyForNames`, `createConnectorToolCatalog` (`ToolCatalog.lookup` now takes the maker's agent id).
- MCP: `kind: "app"`, `artifact_promote`, the `PLATFORM_TOOL_LABELS` entry and the port adapter over `artifactGrants.promote`.
- The page bridge from B.7 is merged in.

## Local round trip (vite dev on port 3108, scratch seed scripts, not committed)

- App with `server/index.js`: a member's POST to `/api/submit` stored a submission through `HM.setItem` in the `AppStore` Durable Object, and `/api/list` returned it. The same through a snapshot link read it, and a write from the snapshot link answered 502 with the fixed body (the app saw `forbidden`).
- Wrong artifact in the path and a bad token answered 401, a preflight 204.
- Tool call from the app's server as a member (a real Clerk user in the dev org) and as a live link: both passed the catalog, grants, membership check and runner, and reached the connector, where the test connector (`shop.invalid`) could not be reached. An argument over its limit (`days` 99 against a max of 30) was refused with `not_granted` on both paths.
- Not run: a connector that answers (the connector URL check refuses local addresses and a tunnel was not set up), and the page bridge in a browser (B.7's own end to end test covers it with a real MessageChannel).

## Nits left

- `/api/*` shadows a static file under an `api/` folder for every artifact kind.
- `callShare` checks the grants of the link's pinned or current version, not the version the app server runs, so during a promote old server code runs under the new version's limits.
- Live-call access-log rows for app calls leave region, city and ASN null (only `cf.country` goes in `place`).
- `visitorMeta` runs on every `/api` request, members included, and each request composes the services again.
- `checkManifest` keys tools by the calling principal's agent, `recordVersionGrants` by the artifact's: with same-named connectors the pre-check can pass and the write-time check fail.
- A member's `/api` request does not re-check membership before the app reaches approved hosts; only `callTool` does.
- `proxyForNames` matches by name, so a secret deleted and re-created under the same name inherits the version's approval.
- Flood guard: both keys are counted on every request, the IP bucket is shared across links, and `truncateIp` null is skipped.
- `platformFailure` logs only the error name.
- `isAppRefusal` trusts the message prefix that `appError` makes.

## Ideas beyond the scope

- Platform read tools (`harbourmaster/...`) as grantable tools: the `ToolRunner` only runs connector tools, so the catalog leaves them out. They need a runner that calls the platform's own tools in process.
- Give the app server a way to see which grants limits it runs under.

## Steps for Dom

- Create the rate limit namespaces if the account needs them: `APP_API_LIMIT` uses ids 2004, 2005 and 2006 (like `SHARE_OPEN_LIMIT` with 2001 to 2003); wrangler creates them on deploy.
- Deploy staging first: the `v7` migration adds the `AppStore` class.
- Check staging and production for manifests with a non-page `entry` (B.7 nit).
- `packages/services/src/runs.test.ts` "an hour of never-claimed runs" timed out at 60 s once under load, also on `v3/artifacts`; it passed in the full run. Not B.8.
