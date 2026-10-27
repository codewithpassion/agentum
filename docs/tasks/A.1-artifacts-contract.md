---
id: A.1
title: Artifacts contract (phase 1 and 2 schema, protocol, seams)
milestone: A
size: L
status: done
depends_on: []
branch: task/A.1-artifacts-contract
lane: db
executor: claude
---

The contract for artifacts, phases 1 and 2. Spec: `docs/v3/artifacts-prd.md` (the PRD). It holds every schema change, shared type and seam the other A and B tasks need, so they can run in parallel without touching the same files. No other A or B task changes `packages/db/src/schema`, `packages/db/src/shared.ts` or generates a migration.

The integration branch is `v3/artifacts`, not `main`. Branch from it and merge it in.

## Scope

Schema and migration
- `packages/db/src/schema/artifacts.ts`: `artifacts`, `artifact_versions`, `artifact_version_files`, `artifact_shares`, `artifact_views`, `artifact_view_salts` and `artifact_grants`, exactly as the PRD's "Data model (sketch)" lists, phase 2 columns included: version `status` (`published`, `proposed`, `rejected`), share `data_mode`, `granted_by`, `live_tools`, view `tool_key` and the phase 2 surfaces and outcomes. `artifact_grants`: id, workspace_id, version_id, kind (`tool`, `secret`, `host`), target, status (`pending`, `approved`, `rejected`), decided_by, decided_at, created_at. `artifacts.id` is a random UUID, every other id a ULID, every table has `workspace_id` with a foreign key. Indexes as the PRD lists, unique `(artifact_id, number)` and unique `token_hash`.
- `workspaces.artifact_links_enabled` (boolean, default true).
- `bun run generate` in `packages/db`, commit `migrations/` with `meta/`. The `events` triggers must survive.

Shared (`packages/db/src/shared.ts`)
- `ARTIFACT_KINDS` (with `app`), `ARTIFACT_AUDIENCES`, `ARTIFACT_VERSION_STATUSES`, `ARTIFACT_VIEW_SURFACES` (with `live_call`), `ARTIFACT_VIEW_OUTCOMES` (with `refused`, `rate_limited`, `error`), `ARTIFACT_SHARE_DATA_MODES`, `ARTIFACT_GRANT_KINDS`, `ARTIFACT_MAX_FILES = 200`, `ARTIFACT_MAX_BYTES = 16 MB`, `ARTIFACT_FILE_MAX_BYTES = 10 MB`, `ARTIFACT_WORKSPACE_MAX_BYTES = 1 GB`, `ARTIFACT_VIEW_KEEP_DAYS = 365`, `ARTIFACT_APP_STORAGE_MAX_BYTES = 20 MB`, live link limits (60/min, 1000/day, 10/min per visitor) and the new `EVENT_TYPES` from PRD section 6 plus `artifact.promoted`, `artifact.grant_decided`, `artifact.handed_to`.
- The payload shape of `artifact.published` (`artifactId`, `versionId`, `version`, `title`, `kind`, `sessionId`, `runId`, `toolCallId?`) where event payload shapes live.

Protocol (`packages/protocol/src/artifacts.ts`, own `exports` entry)
- View-token claim schema (artifact id, version id, viewer kind `member` | `link` | `test`, share id?, user id?, expiry), the manifest schema (path to `{ sha256, size, contentType }` plus entry), the content path builder (one function: `/a/<uuid>/c/<token>/<path>`), the `_hm/` reserved prefix, the content type by extension map.
- Bridge message zod schemas, phase 1 and 2: `ui/initialize` and its result `{ theme, viewer, version }`, the size-change notification (confirm the MCP Apps name from the spec linked in the PRD), `ui/open-link`, `tools/call` and result, storage get/set/delete/list (per-viewer and shared scope), `ui/message`. JSON-RPC 2.0 framing.
- tRPC input and output zod schemas and inferred types for every procedure in the PRD's tRPC table, plus phase 2 `callTool`, `promote`, `decideGrant`, `pin`/`unpin`, `handTo`, and `createShare` with `dataMode` and `liveTools`. Types `ArtifactCard`, `ArtifactDetail`, `ArtifactVersion`, `ArtifactShare`, `ArtifactView`, `ArtifactThreadPart` (the `artifact` part the thread fold emits). UI and services code against these.
- Share open and call HTTP response schemas (PRD "HTTP routes").

Pure modules both service tasks and the content route need (`packages/services/src/artifacts/`, entries that import no drizzle)
- `view-token.ts`: `hm_view_` sign and verify, HMAC-SHA-256 over the claims with WebCrypto, constant-time compare, expiry check. Key passed in.
- `policy.ts`: `defaultAudience(session | null)` (R1.5), `canOpen`, `canManage` (owner or admin), `canCreateLiveLink` (owner only), `agentCanUpdate` (R1.9) over plain records.

tRPC seams
- `apps/web/src/server/trpc/artifacts-router.ts` (core: list, get, versions, restore, rename, setAudience, remove, promote, decideGrant, callTool, pin, unpin, handTo) and `apps/web/src/server/trpc/artifact-shares-router.ts` (open, shares, createShare, revokeShare, views, setLinksEnabled), each procedure with its input and output schema from protocol and a body that throws `NOT_IMPLEMENTED`. Merge both under one `artifacts` key in `router.ts`, so the client sees `artifacts.<procedure>`. A.2 fills the first file, A.3 the second.

UI seams (`apps/web/src/components/artifacts/`)
- Stub components with final props, rendering a placeholder: `artifact-frame.tsx` (`contentUrl`, `viewer`, `version`, `title`, `className`, `interactive`), `share-dialog.tsx` (`artifactId`, `open`, `onOpenChange`), `access-log.tsx` (`artifactId`). A.8 fills the frame, A.10 the other two. Keeps the viewer, the thread card and the share UI in separate files.

## Check
- `schema.test.ts` and `foreign-keys.test.ts` cover the new tables; the migration applies on a fresh `migrated()` database; the `events` triggers still refuse UPDATE and DELETE; a second version with the same `(artifact_id, number)` fails.
- Protocol tests parse and reject every bridge message, token claim and manifest.
- `view-token` tests: round trip, tampered, expired, wrong key. `policy` tests for each rule.
- The stub routers type-check under `artifacts.*`.
- `bun run check && bun run test && bun run build` pass.

## Log
- 2026-10-27: planned (controller).
- 2026-10-27: dispatched.
- 2026-10-27: ready at 1135f62, review clean after 1 fix round; merged.
