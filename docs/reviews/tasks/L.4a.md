# L.4a live service core

The core implementation is complete in `packages/services/src/live-artifacts/service.ts`, exported as `@repo/services/live-artifacts/service`. This slice does not complete parent L.4: comments, ask, routers, guest authentication and app composition remain in their assigned slices. No schema, migration or task files changed.

## Factory and integration API

`createLiveArtifactsService(deps)` takes `db`, `atomic`, `blobs`, `clock`, `events`, `artifacts`, `rooms`, `content`, `ticketKey` and `identity`.

- `db` is the existing `Database`; `atomic` is the existing D1/SQLite atomic adapter. The tests use the real migrated SQLite database with foreign keys enabled.
- `blobs` uses the current `LibraryBlobs.get/put` shape. Static artifacts and live checkpoints share the extracted `artifacts/blob-writer.ts` implementation for quota checking, hash deduplication, bounded blob writes, manifest validation and storage keys. Conversion and audience/delete mutations reuse the existing artifacts service. Version lookups use the existing DB queries.
- `artifacts` needs `readFile`, `setAudience` and `remove` from `ArtifactsService`.
- `ticketKey` is a required nonblank private signing secret supplied by composition. `identity(member)` supplies the trusted display name and colour. No environment reads or client-supplied identity are involved.

Every public method takes an authenticated `Principal` as its first argument. Only users and runs are admitted; system, machine and trigger principals are refused. Guest grants and authentication are deliberately outside this slice.

Methods:

- `createDocument(principal, { title, markdown? })` imports markdown through the codec, creates an ordinary `document` artifact and its initial checkpoint in one atomic DB write, and returns `LivePublishResult`.
- `convertDoc(principal, { artifactId, title? })` authorizes the static `doc`, reads its current entry through `artifacts.readFile`, imports it and creates a new document with `convertedFromId` pointing to the source. The source stays intact. Conversion preserves the source audience and requires write access.
- `join(principal, { artifactId })` returns the existing protocol `LiveJoinResult`: `{ ticket, roomUrl, role, participant }`. It resolves current audience, named membership, expiry/revocation and principal restrictions from DB, then signs through `ticket.ts`. Tickets have unique `jti`, a 120-second admission lifetime and a 15-minute connection lifetime.
- `checkpoint(principal, { artifactId, state, revision })` requires editor/owner rights and writes a new published normal artifact version with `state.ydoc`, `index.md` and `index.html`. It advances `currentVersionId` and `liveRoomRev` atomically with version/file rows and checkpoint/publish events. Revisions must be safe nonnegative integers and advance beyond the last checkpoint. The revision is recorded in the state contract, version message, events and returned result. Existing artifact file/total/workspace limits also apply.
- `restore(principal, { artifactId, version })` requires owner/admin rights, loads that artifact's authorized published checkpoint and its state blob, runs `content.loadDocument`, invokes the room restore port with the actor and source version, and persists the room's returned state/revision as a new version. It emits `artifact.restored` with `fromVersion` in the same DB commit.
- `invalidateAccess(principal, { artifactId, participantId? })` requires owner/admin rights and invokes room refresh for one participant or all connections.
- `setAudience(principal, { artifactId, audience })` and `remove(principal, { artifactId })` authorize, delegate the DB mutation to the existing artifact service and refresh all room connections. Integration must use these wrappers for live artifacts; membership mutations in later slices must call invalidation after their writes.

`LivePublishResult` extends the ordinary `PublishResult` with `revision`, so creation, conversion, checkpoints and restore return `{ artifactId, versionId, version, revision, bytes, files }`.

## Required ports

`DocumentSnapshot` is `{ state: Uint8Array, revision: number }`.

`LiveContentCodec` has three required operations:

- `importMarkdown(markdown): Promise<DocumentSnapshot>` imports and sanitizes with the shared document schema.
- `exportDocument(snapshot): Promise<{ markdown, html }>` validates/sanitizes and renders the supplied document state.
- `loadDocument(state): Promise<DocumentSnapshot>` validates/sanitizes stored state before a restore.

There is no fallback codec or no-op implementation in the service. L.2/L.7 must supply the shared document implementation. The service tests inject an executable JSON document codec to isolate these port calls from the parallel Yjs/schema package; these are DB persistence and authorization tests, not claims of Yjs/editor integration.

`LiveRoomsPort` uses a scope `{ artifactId, workspaceId }` on every operation:

- `url(scope): string` supplies the socket URL.
- `restore(scope, { snapshot, versionId, byParticipant }): Promise<DocumentSnapshot>` applies the validated checkpoint as one live change and returns the resulting full state with a new monotonic revision. The service persists that returned snapshot, rather than copying an old revision over the working room.
- `refresh(scope, participantId?): Promise<void>` must recheck current authorization and close/downgrade affected sockets. Omitted participant means all connections, including after deletion.

L.7 adapts the room RPC and trusted room checkpoint callback to these ports. Background checkpoint callers must supply an authorized user/run principal; this factory does not expose an unauthenticated workspace-ID write path. Ticket single-use consumption, connection expiration and actual socket disconnection belong to L.3. Room mutation and DB/blob persistence are separate systems: a failed save after room restore must be retried through a checkpoint; the factory does not claim a distributed transaction.

## Authorization and consistency evidence

Owner and workspace admins receive owner rights. Active named user grants supply viewer/commenter/editor roles; other workspace-audience members are editors. Private artifacts are otherwise hidden. Read-only API/OAuth credentials and dry runs receive viewer tickets and cannot write. Unscoped runs see artifacts under the existing agent policy and may edit only artifacts made by or handed to their agent. Scoped runs cannot create artifacts or cross their artifact scope; their rights are capped by their current asking user's role. Guest-scoped runs without a member asker are refused in this slice.

The service validates the stored run/agent/session chain in the same workspace before following those parent references. Artifact, membership, checkpoint-version, checkpoint-file and current-version lookups are workspace-scoped. Tests deliberately insert or mutate foreign-workspace references that SQLite's single-column foreign keys permit and prove they cannot be followed.

Checkpoint numbering is based on the authorized row's current version before slow codec/blob operations. Concurrent saves on that base choose the same number and the existing unique index rejects the loser, preserving the newer pointer and revision. DB writes roll back together on atomic failure; immutable blobs written before a failed DB commit can remain unreferenced, as with the existing artifact service.

## Validation

- `bun install --frozen-lockfile` completed. Missing ignored `apps/web/.env` was initialized from `.env.example` only after checking it did not exist; existing values were not overwritten.
- `bun run --cwd packages/services test src/live-artifacts src/artifacts/service`: **118 pass, 0 fail**, including 19 new service tests, 2 ticket tests and existing artifact regressions.
- `bun run check`: **passed**, all 9 tasks successful, no cached results; Ultracite, typechecks and boundary lint clean.
- `bun run test`: **passed**, all 9 workspace tasks successful, no cached results, plus root script tests. Aggregate: **8,060 pass, 1 skip, 0 fail** (services: 3,061 pass; web: 3,249 pass and one existing skip).
- `bun run build`: **passed**, both tasks successful, no cached results. The build emits its existing Vite sourcemap warning and completes successfully.
- All validation commands were allowed to finish and returned exit code 0 on the final implementation.

Implementation commits on branch `t3/live-artifacts-service`: `a5604aea` (shared blob writer), `f500fb44` (core factory and DB regressions), `6e2bff8f` (revision result and restore/writing-run audit).

No external blocker has been identified. Composition, real document-codec wiring and Durable Object behavior remain the explicitly separate integration work, not substitutes for missing core methods.

## Independent review — 2026-10-27

Reviewed merged core at `8fdc8e70342dfb7c97a34e02d3859e89bbd31f36` from branch `t3/review-live-artifacts-core` (starting HEAD `0122cfed5328d5608a9de0960d5be9aa5ae14fe1`). Verdict: **changes required before live integration**. The findings below are code-path analysis; the existing suite does not exercise these failure/interleaving cases.

### Must fix

1. **High — access revocation can commit without a recoverable room refresh.** `packages/services/src/live-artifacts/service.ts:600` and `:644` commit `remove`/`setAudience` before awaiting `rooms.refresh`. If refresh fails, existing sockets retain their prior access. Retrying removal or calling `invalidateAccess` cannot repair it because `access()` uses `findArtifact`, which excludes the now-deleted row (`:255`, `:551`); even audience retries depend on an external caller noticing the partial failure. Persist a durable invalidation/outbox with the mutation and retry it independently of artifact visibility, or provide an equivalent reliable post-commit retry mechanism, including deleted rooms. Test a failing refresh followed by recovery and verify the existing connections are downgraded/closed. The 15-minute expiry is a backstop, not the PRD's immediate revocation.

2. **High — a ticket minted before revocation can admit a stale role after refresh.** `packages/services/src/live-artifacts/service.ts:561` issues a self-contained ticket valid for two minutes; `:600` and `:644` refresh only connections present when the RPC runs. A user can obtain a ticket, be revoked or lose workspace audience, then present that unexpired ticket after the refresh. Ticket verification checks signature, room and time (`packages/services/src/live-artifacts/ticket.ts:29`), not current access. Require a current authorization check or a durable access-generation check at admission (and renewal), coordinated with mutations, so an earlier ticket cannot reopen access. Add an issue-ticket / revoke-and-refresh / connect test, including deletion and role downgrade. This spans the service and L.3/L.7 admission boundary, but must be resolved before the core's access-refresh guarantee is relied on.

3. **Medium — concurrent publications can exceed the workspace blob quota. Resolved by L.Q (2026-10-27); see [implementation and concurrency evidence](L.Q.md).** `packages/services/src/artifacts/blob-writer.ts:45` reads current distinct bytes and checks them outside the atomic version/file commit; `packages/services/src/live-artifacts/service.ts:349` then performs slow blob writes before committing at `:436`. Two distinct artifacts can both observe capacity and both commit, exceeding the 1 GB limit. The extraction preserves the pre-existing static writer race, and live checkpoints add another concurrent writer. Enforce quota with a workspace-scoped atomic reservation or conditional accounting in the same transaction as file rows, with deduplication and rollback semantics; cover competing static/live and live/live commits near the limit. Orphan blob cleanup remains a separate storage concern.

### Integration gates and observations

- The restore port changes the room before the DB save (`service.ts:633–642`). A blob/atomic failure or a competing checkpoint can leave the restored live state without its restore event/version. The report correctly acknowledges separate systems, but integration must provide a durable retry/reconciliation path that saves the actual room revision and preserves restore provenance, including the race with a checkpoint. Verify this with the real room; a blind retry of `restore` would apply the change twice.
- L.2 must implement schema validation/sanitization and rendering on import, export and restore; L.3/L.7 must adapt snapshot/revision semantics, authenticate background checkpoint calls, consume ticket IDs atomically, enforce connection expiry, recheck current roles, and refresh all affected sockets. The injected JSON codec is a port test, not evidence of Yjs or DOM safety. Exercise real codecs and room RPC together before declaring parent L.4 complete.
- User and run role ceilings, workspace-scoped run/agent/session and version references, private access, active/expired/revoked named grants, source write permission and conversion ownership were inspected. A read-only join only reads DB and signs a viewer ticket; it makes no service mutation. Ticket signing uses a strict claim schema, trusted identity port and bounded lifetimes; no extra identity fields enter the signed token. Room single-use and live socket enforcement remain integration responsibilities.
- Concurrent checkpoints based on the same current version choose the same version number; the unique index rejects one and the atomic DB operation rolls back version, files, pointer and events. Blob writes precede that transaction and may leave unreferenced objects. The focused tests cover this and injected atomic failure; they do not establish quota serialization or distributed restore recovery.

### Independent validation

`bun install --frozen-lockfile` succeeded in this worktree (the first test attempt before installation failed to resolve workspace packages). `bun run --cwd packages/services test src/live-artifacts src/artifacts/service` then passed: **118 pass, 0 fail**, including migrated SQLite-backed live service and static artifact tests. No product or task files were edited. Full root checks/build were not rerun for this report-only review; the implementation report above records the earlier run.
