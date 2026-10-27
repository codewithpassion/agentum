# B.2 review record

Branch task/B.2-app-gateway. Code in `apps/web/src/server/app-gateway/`.

## Rounds

Round 1 at 9a23268: not clean, five must-fix. Four were code and are fixed in 1ee6251: visitor address headers (`cf-*`, `x-forwarded-*`, `x-real-ip`, `true-client-ip`, `forwarded`, `via`) reached the app, `listItems` without a prefix listed nothing, a failing port skipped the content headers, and `area` from app code was not checked. The fifth is a decision for Dom (below).

Round 2 on 1ee6251: clean.

## Choices a later task relies on

- `ports.ts` is the contract B.8 fills with `AppGatewayPorts`, passed to `defineAppEntrypoints(portsOf)` in `entrypoints.ts`. The Worker entry exports `AppHost` and `AppOutbound` from its result. `types.ts` holds the `HM` interface from the spike.
- `globalOutbound` is `null` when the version has no `host` grant row of any status, otherwise the `AppOutbound` stub with ids only (spike rule 5). That set is fixed at publish. `AppOutbound` reads approved hosts on every request and refuses all when there are none.
- A `test` token becomes `{ kind: "test" }`: it reads the shared area and writes and calls nothing. `whoami` can return `"test"`, one more value than the spike's interface.
- The gateway sets `Cache-Control: private, no-store` after A.4's wrapper, so live data is not cached for five minutes.
- `checkServerBundle` (modules.ts) is the publish-time check for A.2 or B.4 to call. Server files must be JavaScript.
- The gateway does not check that the uuid in the path equals `claims.artifactId`. B.8's route does that before calling.
- The real-loader test (`real-worker.test.ts`) runs the gateway in Miniflare, found through wrangler's dependency. It prints a DNS failure trace for `approved.invalid`, which is expected.

## Nits left

- A non-string prefix from app code lists the whole area. `checkArea` returns a value nobody uses.
- The catch-all in `handleAppRequest` logs nothing, and a 502 from a broken bundle leaves no trace.
- The wall timer ends at the response headers, so a streamed body can run longer.
- Copied `content-length` and `content-encoding` could be dropped.
- `export default class` passes the publish check and fails at call time.
- The outbound allowlist compares hostnames, so any port on an approved host is allowed.
- A member's storage calls do not re-check membership, only `callTool` does (B.5's adapter).
- A version with no server part is a 502, not a 404.

## Ideas beyond scope

A per-request outbound that knows the viewer would need either a per-viewer-class Worker id or Workers for Platforms.

## For Dom

Decide the outbound rule for snapshot links. `AppOutbound` is per version, so a snapshot-link or just-revoked viewer's `/api` call can make the app reach approved hosts with vault secrets filled in, which R2.6 would call a server call needing a person's rights. Options: accept it for now, or have B.8's route refuse `/api` for snapshot links on versions that declare hosts.
