# LD.5 — production deck rooms, services and tools

Implementation commits: `ec7242f0`, `e7a9125d`, `068de073`, `9d5c18cc`. The lane merged controller recovery fixes `d983f853` and `e67e440d`; no new database schema or migration was needed. Server/service/protocol/room/MCP files and backend fixtures only were authored here. UI integration and structural editor binding acceptance belong to LD.6.

## Authority and durable lifecycle

The existing production `ArtifactRoom` binding now dispatches document/deck content by its persisted artifact kind. Deck state uses the real `Deck` and production `richTextCodec`. Initial creation initializes shared theme maps before publishing the first checkpoint. Untrusted ingress goes through isolated complete-candidate validation before synchronous SQLite transaction, authority application and broadcast. Original Yjs updates retain client IDs, clocks, deletion history and independent property/slide merges; duplicate updates do not advance revisions. Missing dependencies, hidden roots, bad fields and oversized candidates are refused. Session message/byte budgets bound deck ingress. A rejected client must rebuild a new replica from authority.

One `DeckSceneAdapter` stays attached to the authoritative deck for the room incarnation. Tool reads return opaque retained observations; writes preserve per-element and per-key human guards, including edit/revert history. Compaction does not replace the authority or expire observations. Restart and restore explicitly require a fresh read. Tool call digests, chunked results, original change deltas, before-state and provenance are persisted with the accepted mutation; retries return the durable result. Scoped Yjs revert reconstructs that origin's history, validates its candidate and preserves later human changes.

Decks share document authentication/admission, single-use persisted ticket consumption, fresh principal/run/key/access checks, connection renewal/expiry, access fences and production permission refresh alarms. The production wrapper refreshes active connections every two seconds, within the five-second revocation bound. Accepted checkpoint recovery uses the controller's frozen opaque publication receipt captured before and atomically with pending snapshot state; it does not require an expired connection credential to become valid again. New writes still require current authorization.

Checkpoint publication uses ordinary artifact versions, quota accounting, blob ownership and durable scheduling. It writes `state.ydoc`, `deck.json`, combined constrained `slides.html`, static rendered `index.html` and the compatibility `index.md` view. Combining slide interchange into one file keeps all 500 supported slides inside the existing file-count quota. Static rendering escapes content and renders text, geometry, shapes, owned images, table cells, groups and connector endpoints; icons have a textual accessible representation. Static checkpoints do not play builds/transitions or replace the interactive deck editor. Restore is an owner-authorized monotonic live change with idempotent provenance; peers receive its admitted delta.

## Concrete client contracts

`@repo/protocol/deck` exports `DeckRoomSession`, `PresentationControl`, `presentationControlSchema`, `PresentationResult`, `PresentationBroadcast`, `TrustedPresentationPosition` and `PRESENTER_LEASE_MS`.

The session JSON precedes native Yjs sync step 1 and contains `type:"session"`, `kind:"deck"`, `awarenessId`, `expiresAt`, current `role`, trusted `participant:{id,kind,name,color}`, room-incarnation `epoch` and `ownBlobUrls`. Native frames remain document-compatible: outer 0 for sync subtypes 0/1/2; outer 1 for awareness; outer 3 for awareness query. The client completes authoritative sync before enabling edits. `renew` tickets, `renewed`, `role` and rejection/close controls remain available. Core rejection paths are safe to surface, and rejected optimistic structs must never be merged back into the replacement replica.

Presence accepts location only: `slideId`, `selection` and `pointer`. The room supplies identity and clocks, checks existing slide/element IDs and finite bounded pointers, echoes trusted awareness to its sender and prunes locations invalidated by scene deletion. Document cursors are refused in deck presence. Deck asks derive current slide number and surviving selected element IDs from room state, rather than trusting browser-supplied speaker/selection metadata.

Presenter controls are strict JSON `{type:"presentation",action,requestId,...}`. Acquire requires `slideId`/`build`; position requires those plus `leaseId`; renew/release require `leaseId`. Results use `{type:"presentation-result",requestId,ok,leaseId?,expiresAt?,reason?}`. Broadcasts use `{type:"presentation",position:{presenterId,slideId,build}|null}`. A lease is opaque, connection-owned and expires after 15 seconds; clients renew while presenting. Knowledge of another connection's token does not grant ownership. Expiry, permission loss, disconnect, restore and deletion of the presented slide release spotlight. No identity or lease authority comes from client awareness.

The mounted root `liveArtifacts` router now supplies:

- `createDeck({title,slides?:string[]})` → ordinary `LivePublishResult`.
- `open({artifactId})` → `{artifactId,kind,title,role,revision,state:number[]}` from the current room.
- `history({artifactId})` → published version rows `{id,number,createdAt,message,authorKind,authorId}`.
- Existing `join`, `checkpoint`, `restore`, `policy`, `ownBlobUrls`, comments, ask, session and lifecycle methods accept decks. `checkpoint` validates supplied bytes/revision against authority; `restore` retains its existing `{artifactId,version,requestId?}` contract.
- Existing image upload route and ownership registration remain real storage operations; `ownBlobUrls` returns `{urls}` and image upload returns `{url,alt}`.

## Production MCP integration

The actual runtime server registers `deck_read` and `deck_write` through the shared registration boundary. Read-only servers omit writes; dry runs record/skip them. Ask-before labels cover both deck tool keys. `artifact_create` supports `kind:"deck"` with optional constrained slides and refuses mixed static/document content. `artifact_update` on a deck names `deck_write`. Document tools and document creation remain available.

The host binds calls to authenticated principals, workspace, run and tool-call identity. The room checks current writer access again inside serialized admission. Artifact-triggered runs remain bounded independently by current source and target roles. Structured room RPC outcomes preserve deliberate `ToolError` codes and exact core HTML paths; internal errors retain the generic boundary.

## Executable evidence and final gates

Actual workerd fixtures use production deck core/codec and real SQLite. `deck-room.test.ts` covers two-client sync and trusted hello, theme initialization, concurrent properties, competing slide moves, independent slide additions, duplicate delivery, remote ABA guards, atomic invalid tool batches, authoritative presence, scoped revert retaining a later human edit, real byte-triggered compaction with observations retained, hostile binary ingress, restart, restore/observation invalidation/idempotence, replay, stale-role admission, revoke, connection expiry, presenter acquire races/token theft/renew/position/downgrade, actual 15-second expiry and disconnect release.

`production.test.ts` exercises real run-token MCP registration/composition, deck and document creation/read/write, durable call replay, exact validation-path transport, ordinary D1/R2 version files, empty decks, source and target viewer ceilings, production admission/replay/restart, large document storage, durable maintenance, and controller checkpoint recovery after credential ageing and changed actor pointers. `deck-content.test.ts` exercises escaped static/checkpoint interchange, connector geometry, shared codec state round-trip and revoked blob ownership. Router tests include all new procedures in authentication, authorization and exact-principal forwarding checks. MCP package tests cover the actual registered names, read-only omission and dry-run behavior.

The root suite initially found Bun's in-process repeated-bundling failure (`EISDIR`/unexpected reads). Both room fixtures now build their Worker in an isolated Bun subprocess, matching the established production-fixture pattern. The document and deck workerd tests pass together after that fix. No test assertion was weakened or lint rule disabled.

Full authenticated app/browser and staging acceptance remain outside this backend gate: signing-key setup was cancelled, and this lane requested no secrets, generated no real credentials, sent no email, and did not push, deploy or open a PR. Existing screenshots and environment files were not overwritten. The new worktree's absent ignored `.env` was temporarily populated from the repository's `.env.example` only for the documented root type-generation prerequisite; it was compared with that template and removed after validation, restoring the initial absent-file state.


### Final recorded results (2026-10-27)

At implementation head `9d5c18cc`:

- `bun run check`: passed; 12/12 tasks successful, root formatting clean and boundary lint clean. The final run followed the RPC outcome and static-renderer changes.
- `bun run test`: passed; 12/12 package tasks successful plus root scripts, **8,343 passed, 0 failed, one existing web skip**. Web: 3,319 passed/one skip; MCP: 404 passed. The final web suite includes the subprocess-bundled document/deck rooms and production deck validation-path assertion.
- `bun run build`: passed; 5/5 tasks successful, production web build and dev-only boundary check clean. The existing CSS sourcemap warning is non-fatal.
- Final `apps/web/dist/client` scan for `drizzle`, `cloudflare:workers`, `ARTIFACT_ROOM_SERVICE`, `CLERK_SECRET_KEY`, `RUN_TOKEN_KEY` and `SECRETS_KEY`: no matches. `git diff --check`: clean.
- Focused final production workerd test: passed, 24.6 seconds. Combined actual document/deck room test run: two passed, 61.9 seconds. Extended deck runner includes a real 15-second presenter expiry. Focused checkpoint rendering/ownership tests: two passed, 11 assertions.

Backend implementation and local verification are complete. Independent backend review remains a controller gate. LD.6 owns actual desktop/mobile editor/provider tests, including its deck-only binding experiment for structural rich-text operations; this backend does not admit y-tiptap migration roots or claim that client gate complete. Authenticated full-app/staging acceptance remains open under the cancelled signing-key setup.

### Combined-main verification and fixture timing follow-up

The controller merged `9d5c18cc` as `2831c182` and independently completed combined-main root check/test/build successfully. The recorded logs are `/tmp/harbourmaster-live-checks/deck-merged-{check,test,build}.log`: check 12/12 plus clean boundary lint, all workspace tests plus root scripts 284/0, build 5/5 plus the 203-file dev-only check. The controller's client JS scan found no `drizzle` or `cloudflare:workers`.

A parallel loaded client-worktree root run exposed a presenter-test timing assumption: the runner slept 50 ms and then searched for the response. It now listens for the actual WebSocket response matching the request ID, with a five-second failure deadline; no production timing or assertion was relaxed. The focused actual deck workerd test passed after that change (19.6 seconds). The controller requested no repeat of its completed root runs for this fixture-only fix.

The client lane subsequently rejected its temporary stable-binding experiment because initially empty table-cell undo could diverge between bound peers. That lane is reverting to the original y-tiptap binding and coordinating a controller-owned strict metadata resolution. This is an explicitly open client/core acceptance issue; the backend does not silently admit unknown roots or claim the structural rich-text browser gate complete.
