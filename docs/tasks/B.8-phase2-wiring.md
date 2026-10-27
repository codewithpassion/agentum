---
id: B.8
title: Phase 2 wiring and bindings
milestone: B
size: M
status: in_progress
depends_on: [A.6, B.2, B.3, B.4, B.5, B.6]
branch: task/B.8-phase2-wiring
lane: worker
executor: claude
---

Spec: `docs/v3/artifacts-prd.md` (the PRD), phase 2, and `docs/v3/phase2-spike.md` (B.1's findings, which win where they differ). A.1 holds every schema change; this task changes none of `packages/db/src/schema`, `packages/db/src/shared.ts` or migrations. Integration branch: `v3/artifacts`.

## Scope
- `server.ts`: route `/a/<uuid>/c/<token>/api/*` (all methods and `OPTIONS`) to B.2's `AppGateway`, and mount `POST /api/share/:token/call` with its own rate-limit binding.
- `compose.ts`: build the call service, the store port and the gateway's ports.
- MCP (moved from B.4): `artifact_promote` in `packages/mcp/src/tools/artifacts.ts`, `kind: "app"` accepted by create and update, dry-run text, `PLATFORM_TOOL_LABELS` entry, the port adapter to B.4's promote.
- `wrangler.jsonc`: the storage binding from `docs/v3/phase2-spike.md` (Durable Object with its `migrations` entry, or Facets config), any `ctx.exports` entrypoints (`AppHost`, the outbound) the Worker must export, and the live-call rate-limit binding, each in three places (top level, `env.staging`, `env.staging.previews`); `wrangler types` regenerated.
- Export `AppHost`, the outbound entrypoint and the DO class from the Worker entry as the spike says.

## Check
- A local round trip: an `app` artifact with `server/index.js` that stores a submission through `HM` and lists it, called from its page through `/api/*`; a live dashboard calling a granted tool as a member; a live link call from a fresh browser.
- `bun run check && bun run test && bun run build` pass.

## Refinements (2026-10-27)
- B.2: pass a factory to `defineAppEntrypoints(portsOf)` and export `AppHost` and `AppOutbound` from its result; the route checks the path uuid equals `claims.artifactId`; refuse `/api` for snapshot-link and test viewers on versions that declare hosts.
- B.3: `APP_STORE` binding in three places, the `v7` `new_sqlite_classes: ["AppStore"]` migration, and the `server.ts` export.
- B.5: set `Infra.appStore` to `appStorePort(env.APP_STORE)` in `compose.ts`.
- B.4: replace the stub tool catalog in `artifactGrants` with the real connector and platform catalog; `promote` returns `{status:"promoted"} | {status:"waiting"}`.
- B.6: the call and storage routes are already in `artifactRoutes`, so nothing new to mount for them. Supply `Infra.isOrgMember` (uncached `clerkOrgMemberCheckFresh`) and `Infra.toolRunner` in `compose.ts`. Rate limiting reuses `SHARE_OPEN_LIMIT` with `call:` and `storage:` prefixes.
- Scope addition: enforce argument limits (B.4's `<tool>#<json>` grant rows) on member calls (B.5) and live calls (B.6) before a tool runs, refusing with the same refusal path, with tests.

## Log
- 2026-10-27: planned (controller).
- 2026-10-27: dispatched.
