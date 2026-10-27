---
id: B.3
title: App storage
milestone: B
size: M
status: done
depends_on: [A.1, B.1]
branch: task/B.3-app-storage
lane: worker-store
executor: claude
---

Spec: `docs/v3/artifacts-prd.md` (the PRD), phase 2, and `docs/v3/phase2-spike.md` (B.1's findings, which win where they differ). A.1 holds every schema change; this task changes none of `packages/db/src/schema`, `packages/db/src/shared.ts` or migrations. Integration branch: `v3/artifacts`.

## Scope
- App storage per `docs/v3/phase2-spike.md`'s choice (an `AppStore` SQLite Durable Object per app, or Facets): per-viewer and shared areas, get, set, delete, list by prefix, 20 MB cap per app (`ARTIFACT_APP_STORAGE_MAX_BYTES`), reachable only through `HM` and through the bridge's storage calls (R2.3). Link viewers on snapshot links can read the shared area and never write (R2.6).
- Code in `apps/web/src/server/app-store/`, exposed through a port that B.2's `AppHost` and B.5's tRPC storage procedures use.
- Not mounted, no `wrangler.jsonc` edits; B.8 adds the binding and its migration.

## Check
- Tests for both areas, the cap, prefix listing and the snapshot-viewer refusal, with the DO run in Miniflare or the repo's existing DO test pattern.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: planned (controller).
- 2026-10-27: dispatched.
- 2026-10-27: ready at 334b44a, review clean after 0 fix rounds; AppStore port in apps/web/src/server/app-store/{types,rules,port}.ts; B.8 adds APP_STORE binding, v7 migration, export; merged.
