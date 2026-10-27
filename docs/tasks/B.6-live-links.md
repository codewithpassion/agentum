---
id: B.6
title: Live links
milestone: B
size: M
status: done
depends_on: [A.3, A.6, B.5]
branch: task/B.6-live-links
lane: services-shares
executor: claude
---

Spec: `docs/v3/artifacts-prd.md` (the PRD), phase 2, and `docs/v3/phase2-spike.md` (B.1's findings, which win where they differ). A.1 holds every schema change; this task changes none of `packages/db/src/schema`, `packages/db/src/shared.ts` or migrations. Integration branch: `v3/artifacts`.

## Scope
- In the shares service (A.3's files): `createShare` with `dataMode` `snapshot` (default) or `live` and `liveTools`; only the owner creates a live link, `granted_by` recorded, `live_tools` a subset of the current version's approved read-only grants (R2.10).
- Live call for a `ShareGrant`: checked at call time with no cache (not revoked or expired, switch on, `granted_by` still owner and in an allowed org, tool in `live_tools` and in the current version's grants), rate limits 60/min and 1,000/day per link and 10/min per visitor hash, run in `user` mode as `granted_by` through B.5's call internals, scrub and cap (R2.11 to R2.13). Snapshot links refuse every call and storage write (R2.6).
- Every live call, allowed or refused, writes an `artifact_views` row with surface `live_call`, the tool key and the outcome (R2.14).
- `POST /api/share/:token/call` Hono route (PRD "HTTP routes"): 200 `{ result }`, 403, 429, 404. Add the route module only; B.8 mounts it.

## Check
- Tests for R2.6, R2.10 to R2.14, including revoke-then-call and owner-leaves-org.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: planned (controller).
- 2026-10-27: dispatched.
- 2026-10-27: ready at 62f4bbd, review clean after 1 fix round; 502 for granter-side failures; storage read route; argument limits not enforced yet; merged.
