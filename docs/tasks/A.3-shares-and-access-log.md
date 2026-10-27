---
id: A.3
title: Shares, opens, view tokens and access log service
milestone: A
size: L
status: todo
depends_on: [A.1]
branch: null
lane: services-shares
executor: claude
---

Spec: `docs/v3/artifacts-prd.md` (the PRD). A.1 holds every schema change, shared constant, protocol schema and seam; this task changes none of `packages/db/src/schema`, `packages/db/src/shared.ts` or migrations, and works against A.1's types. Integration branch: `v3/artifacts`.

## Scope
- `packages/services/src/artifacts/shares.ts` (own `exports` entry) and query functions in `packages/db/src/artifact-shares.ts` (own entry). Uses `view-token.ts` and `policy.ts` from A.1, and reads artifact rows through its own queries, so it doesn't wait on A.2.
- Member open (`artifacts.open`): audience check, view row, a member view token for the version (1 hour), content URL from the A.1 path builder. Test token minting for `artifact_test` (5 minutes, run principal, view row with surface `test`).
- Link shares (PRD section 6): `hm_share_` token, SHA-256 hash plus AES-GCM copy under `SECRETS_KEY` (`crypto.ts`), create with expiry and optional pinned version, list with copyable URLs, revoke, owner-or-admin only (R1.27, R1.30), workspace switch for admins (`setLinksEnabled`), `ARTIFACT_LINKS_OFF` passed in as a flag (R1.36).
- Link open: resolve the token to a `ShareGrant` (not a `Principal`), check switch, revocation, expiry, record the view with IP prefix (/24, /48), daily-salted visitor hash, `request.cf` place and network, user agent cut to 256, referrer host; one 404 result for every refusal, with the outcome still recorded for known links (R1.29, R1.31, R1.32). The request metadata comes in as a plain object; the HTTP route is A.6's.
- Views list for the access log, with filter by share. Prune of views older than 365 days and salts older than 2 days (R1.33), as a function the tick calls.
- Events `artifact.share_created`, `artifact.share_revoked`, `artifact.links_switched` naming the person (R1.34). No token in any event, row or log (R1.13).
- Fill `apps/web/src/server/trpc/artifact-shares-router.ts`: open, shares, createShare (snapshot only; phase 2 fields refused for now), revokeShare, views, setLinksEnabled. Don't touch `artifacts-router.ts`, `compose.ts` or `server.ts`.

## Check
- Tests for R1.13, R1.27, R1.29 to R1.34 and R1.36, including a type test (`// @ts-expect-error`) that a `ShareGrant` can't be passed where a `Principal` is expected, and a test that no stored row or event holds a token or a full IP.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: planned (controller).
