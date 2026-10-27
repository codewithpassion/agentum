# L.1 implementation review — 27 October 2026

Implementation commit: `60b56e713c8adc808f75fe212af67f415f3a79c9` on `t3/live-artifact-contract`.

## Delivered contracts

- Shared live kinds `document`/`deck`, guest event actor, artifact session origin, member roles, guest/room view surfaces, timing/size/comment/presence constants and live event names. Existing artifact audiences and static artifact behavior are preserved.
- All eight PRD D1 tables: `artifact_members`, `guest_identities`, `guest_invites`, `guest_codes`, `guest_sessions`, `artifact_comment_threads`, `artifact_comments`, `artifact_live_changes`. Every table has a required workspace foreign key; parent references, active-only grant uniqueness, guest expiry/identity constraints, lowercase email uniqueness, code attempt bounds, comment byte limits and revision bounds are enforced in SQLite.
- Existing tables gain workspace guest switch (default true), nullable checkpoint revision/conversion source, nullable run artifact scope, and nullable guest view identity. `RunRecord` exposes persisted scope rather than losing it during row conversion.
- Generated migrations 0025/0026 and both Drizzle snapshots/journal are committed. Changes are additive: no table rebuild, foreign-key disabling, data rewrite or event trigger replacement.
- Browser-safe `@repo/protocol/live` exports strict schemas for ticket claims, participant awareness, Yjs relative positions, document/deck comment anchors, speaker locations/envelopes and distinct `GuestGrant`. The serializer uses JSON serialization, preserving forged envelope text as text.
- Shared typed `ArtifactRoomContract`, `LiveRoomDirectory`, `LiveCheckpointPort`, operation origins (including future suggestion mode), checkpoint/read/join/comment/thread types and `LiveArtifactsContract` give room/service/MCP/UI implementers common boundaries. Concrete document/deck operations and outline projections are generic parameters owned by their respective packages.
- Exhaustive artifact icon/label and access surface consumers now handle the new variants. Browser run starts remain restricted to `ui` by the existing router.

Phase 4 introduces no additional D1 tables in this PRD. Its suggestion origin, stable anchor IDs and checkpoint/export boundary are represented; suggestion processing, exports, embeds and notifications are later implementations.

## Verification

- Read `CLAUDE.md`, L.1 task, complete PRD and partial spike report; consulted Cloudflare skill/D1 reference for migration review.
- Initialized missing ignored `apps/web/.env` from `.env.example` before install; existing environment files were not overwritten. `bun install` and Worker type generation passed.
- `bun run test`: PASS, all nine package tasks (7,754 passing tests, one existing skipped web directory-enumeration test); root script suite 284 pass. New DB suite totals 83 pass; protocol suite totals 348 pass.
- New foreign-key test visits every foreign key of each live table with a missing parent, then inserts valid parent-first rows. It checks active guest uniqueness, reinvitation after revoke, invalid guest principal, run scope and conversion-source references, and `PRAGMA foreign_key_check`.
- Schema tests check all 69 tables, required workspace columns, nullable new columns, guest-switch default and surviving `events_no_delete`/`events_no_update` triggers. Existing event mutation tests also pass.
- Protocol tests parse every exported schema, both anchor kinds, all roles/participant kinds and speaker surfaces; reject malformed ticket lifetimes/audience/room ID/guest ownership, forged member status, unsafe colors and extra ticket fields; verify hostile text remains in one JSON envelope.
- `bunx turbo run typecheck`: PASS, all nine tasks. Final standalone protocol typecheck also passed after the final envelope adjustment.
- Boundary lint: PASS (`boundary-lint: clean`). Targeted Ultracite lint over the changed application modules: PASS (56 files). `git diff --check`: PASS.
- `bun run build`: PASS, both build tasks, including `check-dev-only` (193 server files). Existing CSS sourcemap warning remains nonfatal.
- Client output scan `rg -l 'drizzle|cloudflare:workers|#/server/' apps/web/dist/client`: no matches.
- Root `bun run check`: BLOCKED by 56 pre-existing lint/format diagnostics exclusively in `scripts/spikes/live-artifacts/{check.ts,client.ts,worker.ts,package.json}`. Full diagnostic run confirmed these paths. The spike remains Terra's separate lane and is untouched here. The pre-commit hook runs global auto-fix and likewise failed on these baseline errors; its incidental spike formatting was reverted, and the implementation was committed with `HUSKY=0` after the independent checks above. Root check is not claimed green.

## Remaining integration assumptions and gates

1. L.0 remains partial. Terra's browser, trusted-awareness filtering and production ticket evidence must complete before realtime integration is signed off. These schemas are validation contracts, not signature verification or authentication implementations.
2. Ticket timestamps use Unix seconds. Services sign version-1 `artifact-room` claims, authorize issuance and bind workspace/artifact/participant/role; rooms verify signature, audience, artifact and expiry before atomically consuming `jti`. Issuance lasts at most 120 seconds; connection expiry is at most 15 minutes from issuance. Connection renewal/revocation must recheck current grant state; disconnect closes the participant's sockets.
3. Awareness identity fields are server-owned. A room assigns stable color, reserves agent identities, validates connection ownership of awareness client IDs and bounds packet size/rate. Schema validity alone does not prevent spoofing. Presence remains ephemeral; server agent state clears after five seconds and is rebuilt after wake.
4. Relative positions use the Yjs JSON representation and shared encoding-version constant 1; document/deck code owns actual resolution, detached-anchor updates, sanitization, operation guards and rich-content conversion. Checkpoint ports must implement consistent revision/version writes and restore behavior.
5. `GuestGrant` deliberately has no Principal discriminator. Guest identity/grant expiry, membership, workspace switch, emergency environment switch and cross-workspace consistency must be resolved/rechecked by services. FK existence is not authorization. Room-local update/snapshot/ticket tables belong to the room implementation, not D1 migrations.
6. Guest run tool scope must be enforced independently in MCP registration and on every live service call. Persisted scope is available in `RunRecord`; this task does not implement guest authentication or start-for-guest execution. Daily caps, per-artifact/thread comment count limits, code send rate limits, guest-present outbound approval rules and invite/code events are service responsibilities.
7. Existing static artifact create/render/MCP paths are not changed to create live content. Later live service/MCP/editor tasks must implement document/deck handling before routing live kinds there. No bindings, deploy, push, PR, task-file edits or extra checkout were made.
