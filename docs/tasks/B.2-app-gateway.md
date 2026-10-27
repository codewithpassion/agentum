---
id: B.2
title: App gateway, AppHost binding and outbound filter
milestone: B
size: L
status: in_progress
depends_on: [A.1, B.1]
branch: task/B.2-app-gateway
lane: worker-apps
executor: claude
---

Spec: `docs/v3/artifacts-prd.md` (the PRD), phase 2, and `docs/v3/phase2-spike.md` (B.1's findings, which win where they differ). A.1 holds every schema change; this task changes none of `packages/db/src/schema`, `packages/db/src/shared.ts` or migrations. Integration branch: `v3/artifacts`.

## Scope
- `apps/web/src/server/app-gateway/`: the `AppGateway` (PRD section 5 "How it runs") that takes a request for `/a/<uuid>/c/<token>/api/*` plus the verified token claims, loads the version's `server/` bundle with `env.LOADER.get("app:<versionId>", …)`, and forwards the request. CORS preflight answers for that path with `Access-Control-Allow-Origin: *` and no credentials. Responses go through the A.4 header wrapper's rules for content (CSP sandbox and the rest).
- The `AppHost` entrypoint passed as the loaded Worker's `HM` binding with props `{ artifactId, versionId, viewer }`, exactly the interface `docs/v3/phase2-spike.md` defines: storage (delegating to B.3's store through a port), granted tool calls (delegating to B.5's call service through a port), filtered `fetch`.
- `globalOutbound`: `null` when the version declares no approved hosts; otherwise an outbound entrypoint allowing only approved hosts and filling secret placeholders like `SecretsOutbound` (`secrets-outbound.ts`). Approved hosts and secrets come from `artifact_grants` rows through a port.
- Keep the loader behind a port like `SkillScriptSandbox` (`sandbox-port.ts`) so Workers for Platforms could replace it.
- Not mounted, no `wrangler.jsonc` or `compose.ts` edits; B.8 wires it.

## Check
- Unit tests with a fake loader for routing, claims, CORS, header rules and the null outbound (R2.1, R2.2).
- A real Dynamic Worker test with Miniflare or `vite dev` loading a sample `server/index.js` that calls `HM`, as `docs/v3/phase2-spike.md` showed works locally.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: planned (controller).
- 2026-10-27: dispatched.
