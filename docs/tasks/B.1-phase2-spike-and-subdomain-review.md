---
id: B.1
title: Phase 2 spike (Dynamic Workers, AppStore vs Facets) and subdomain review
milestone: B
size: M
status: done
depends_on: []
branch: task/B.1-phase2-spike
lane: docs
executor: claude
---

Phase 2 of `docs/v3/artifacts-prd.md` (the PRD) starts with a spike and the subdomain review (R2.8). This task writes no product code. Its output decides how B.2 and B.3 build app server parts and storage.

## Scope
- Read PRD sections 3, 4 and 5 and the existing Dynamic Worker code: `apps/web/src/server/skill-scripts/dynamic-worker-sandbox.ts`, `apps/web/src/server/script-host.ts`, `apps/web/src/server/secrets-outbound.ts`, `sandbox-port.ts`, the `worker_loaders` entry in `apps/web/wrangler.jsonc`.
- Spike in a throwaway folder under `/home/roboto/devel/harbourmaster-wt/tmp/B.1/` (a minimal Worker run with `wrangler dev` or a unit test with Miniflare), answering with evidence:
  1. `env.LOADER.get("app:<versionId>", …)` with a module bundle read from files: how a small `server/index.js` (ES module, `export default { fetch }`) is loaded, warm reuse per id, and what happens with a bad bundle.
  2. An `AppHost` entrypoint passed as a binding via `ctx.exports.AppHost({ props })`, called over RPC from the loaded code.
  3. `globalOutbound: null` blocks `fetch`; an outbound entrypoint that allows a host list works.
  4. Storage: one SQLite Durable Object per app (`AppStore`, keyed by artifact id, per-viewer and shared areas, 20 MB cap) against Durable Object Facets. Check whether Facets work in local dev and in the current wrangler and compatibility date. Pick one, with reasons.
  5. Whether Dynamic Workers run in local `vite dev` (the app's dev server) the way skill scripts do today.
- Subdomain review (R2.8): check each trigger in PRD section 3 "When to move content to a subdomain" against phase 2 apps as the PRD scopes them, and record the answer.
- Write `docs/v3/phase2-spike.md`: the answers with evidence, the chosen storage design, the exact `HM` binding interface (TypeScript) that B.2 and B.3 build to, the wrangler entries phase 2 needs (for the wiring task), and the R2.8 verdict. Keep it under 250 lines.

## Check
- `docs/v3/phase2-spike.md` answers questions 1 to 5 and R2.8, each with what was run and what happened.
- No files outside `docs/v3/` and `tmp/B.1/` change.

## Log
- 2026-10-27: planned (controller).
- 2026-10-27: dispatched.
- 2026-10-27: ready at bb5e91d (review round 1 must-fix, fixed in fd34c77, doc-only, no round 2); merged.
