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

## Independent review — 2026-10-27

**Verdict: changes requested.** Reviewed merged tree at `4c950c23`; the named `678636b5` is the evidence commit, while `60b56e71` contains the implementation. This review did not use the earlier evidence as proof. The phase 1/3 product behavior belongs to later tickets; the integration gates below must be addressed before those paths ship.

### Must fix

1. **Room tickets cannot carry trusted colour.** `packages/protocol/src/live.ts:69-87` uses a strict claims object with no `color`, even though `docs/v3/live-artifacts-prd.md:185` and `:262` require the signed ticket to supply the colour that the room overwrites into awareness. `awarenessEntrySchema` requires it at `live.ts:41-42`. A compliant ticket with colour is rejected, and the room cannot derive the prescribed trusted value from accepted claims. Add and validate the signed colour and test its round trip and malformed values.

### Integration and isolation gates

- `packages/services/src/sessions.ts:180-194` treats all non-UI, non-private sessions as workspace-visible; `packages/services/src/runs/queries.ts:73-76` similarly permits another actor to continue such sessions. Once artifact sessions exist, this can expose a private or people-restricted artifact thread unless L.4 changes both paths to check artifact access. `runs.ts:388` also uses `visibleSessions` for run visibility. The browser start router currently restricts origin to `ui` (`apps/web/src/server/trpc/runs-router.ts:18`), so this is a forward integration gate, not evidence that L.1 alone creates accessible artifact sessions. Test list, transcript, run reads and continuation for unauthorized members, including private artifacts.
- The eight tables have individual workspace and parent FKs (`packages/db/src/schema/live-artifacts.ts:24-185`), but those FKs do not ensure that parent and child workspace IDs match. For example, an artifact member can reference an artifact or guest in another workspace while naming a valid local workspace. The same issue applies to invites, codes, sessions, comments and changes, and the new scope/converted/view references. This is a data-integrity and future tenant-isolation risk, not proof of an existing exposed endpoint. Enforce same-workspace relationships in database constraints or rigorously scoped write and read queries with cross-tenant regression tests before enabling these paths.
- `GuestGrant` (`packages/protocol/src/live.ts:140-147`) is structurally distinct from the existing principal variants; no compile-time negative test demonstrates R3.6. Add a type test that rejects a grant at a Principal-only entry point when the guest path is introduced. `scopeArtifactId` is persisted and read, but its enforcement is assigned to later guest/tool work; do not treat its presence as enforcement.

### Coverage and validation

All eight PRD tables and specified columns are represented, including phase 3 guest tables, partial active-grant uniqueness, token uniqueness, workspace/parent FKs, guest expiry and body-size checks. Drizzle text enums are TypeScript metadata, not SQLite CHECK constraints; service validation must reject invalid roles and author kinds. Phase 4 suggestion mode is represented in `LiveOperationOrigin`, and no later product implementation is required for this review. Speaker envelope, anchors, awareness and room/service interfaces exist; ticket signature, time-at-verification, artifact binding, replay protection and guest expiry are responsibilities of the consuming room/service, not established by parsing claims alone. The current tests parse all exported schemas but do not exercise those verification decisions or real Yjs position values.

Inspected shared kind/origin/actor consumers, session and run access paths, artifact schemas and changed presentation consumers. Existing browser run starts remain `ui`-only; the added kind values propagate to filters and output schemas, while the existing artifact creation input remains restricted to its four legacy kinds. No newly reachable guest principal or live endpoint was found in this change.

After `bun install --frozen-lockfile`, `bun run test` in `packages/db` passed 83 tests and in `packages/protocol` passed 348 tests. DB tests include fresh migration, FK checks, and update/delete event-trigger checks. `bun run generate` in `packages/db` reported “No schema changes, nothing to migrate”; migrations 0025/0026 add tables/columns without rebuilding events. This establishes fresh migration and generated snapshot consistency, not an independent populated D1 upgrade test. Full root check/test/build were not rerun in this review.

## Controller resolution — 2026-10-27

Added required signed `color` to room-ticket claims with the same six-digit hex grammar as awareness. Tests round-trip it and reject missing colour, CSS-like values, short hex and invalid digits. Protocol suite: 348 passed. The earlier combined main install/check/test/build passed. Session/run access and same-workspace relationship regression gates are explicitly carried into L.4; GuestGrant negative typing and scoped tool enforcement remain phase 3 gates.
