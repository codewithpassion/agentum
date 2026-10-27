# L.7 — Production live document wiring

Phase 1 production composition mounts `liveArtifacts` through `createLiveArtifactsRouter`, installs DOM-free content, room RPC, shared ask, comment anchor and MCP document adapters, and exports the real hibernating room with an in-process `ARTIFACT_ROOM_SERVICE` adapter. There is no remote service binding with that name. `ARTIFACT_ROOM` and `LIVE_ARTIFACT_MAINTENANCE` SQLite Durable Objects are bound in default, staging and preview environments with migration v8. Guest execution and deck runtime registration remain disabled in this phase.

## Browser contracts

All three routes authenticate the current caller and authorize artifact access through services. Responses are private/no-store. Images additionally require same-origin requests and current write permission.

- `GET /api/live-artifacts/:artifactId/policy` returns `{ownBlobUrls:string[],agentChanges:{id:string,name:string,start:RelativePosition,end:RelativePosition,text:string}[]}`. Image URLs are verified against that artifact's persisted ownership manifest. Agent ranges are surviving character IDs from persisted accepted room updates, with trusted origin identity; replacement with identical human text does not inherit attribution.
- `POST /api/live-artifacts/:artifactId/images`, multipart field `file`, returns HTTP 201 `{url:string,alt:string}`. Validated raster bytes persist through the files service, then artifact ownership commits before acknowledgement. The upload limit is 8 MiB. Other documents cannot adopt the URL merely because they share a workspace.
- `GET /api/live-artifacts/:artifactId/markdown` returns `{filename:string,markdown:string}` from the latest published checkpoint, rather than an unsaved browser draft.

`liveArtifacts.restore` accepts optional `requestId` for retry identity. Existing artifact versions supply history. The root router carries inferred types without a client root-router cast.

## Authorization and durability

The pre-Clerk room route requires a real authenticated initial request as well as a signed ticket. It forwards the credential request to admission; ticket claims never become a fabricated principal. The room persists opaque private references and refreshes real bearer authorization or Clerk session status, expiry and current organisation membership/admin. Original run lease, API key revocation, read-only and source/target run restrictions remain enforced. Namespace IDs derive from the exact workspace/artifact tuple, with immutable scope checks inside the object.

Document static mutation paths delegate access changes and restore through live services; generic static document updates are refused. Access mutations fence and drain the room before the database commit. Atomic invalidation rows are acknowledged only after room refresh. The durable maintenance object repeatedly sweeps invalidations and comment dispatches every two seconds, re-arms before work, paginates, and provides a checkpoint fallback tick. Active socket rooms independently refresh authorization every two seconds. This does not depend on request `waitUntil` or a minute cron for the five-second invalidation gate.

Room checkpoint identity is also the version identity. Persisted state equality prevents an unrelated snapshot claiming a retry ID. Versions, artifact pointer, origins/change reconciliation, quota and checkpoint event publish atomically; failed publication retains the frozen room save. Restore publication retains original actor and source-version provenance. Published HTML copies verified image assets into version-owned files. Read history is chunked through room storage, with bounded retained metadata and bytes.

MCP document tools use the shared runtime registration and approvals, real service creation and room edits, guarded operation translation and error mapping. JSON-RPC call identity produces stable run change IDs and detects differing replay payloads. Presence heartbeats clear in `finally`; ask selections use canonical normalized room cursors, and blur clears selection. Comments use room-resolved relative anchors.

## Validation

The workerd production fixture uses actual production composition, signed run token, MCP HTTP, SQLite Durable Objects, D1 migrations and R2. It checks create/read/edit and replay; ownership-before-image acknowledgement and cross-document isolation; authoritative attribution; persisted Markdown; failed D1 publication after R2 writes, runtime crash/restart and durable retry; version/change reconciliation; ticket authentication/replay; durable invalidation without subsequent requests; image assets in published versions; and large-document history without an oversized metadata row.

Production fixture bundling runs in a separate Bun subprocess. This isolates Bun's shared build cache from the existing room and app-gateway fixture bundlers; no checks are removed. The fixture-only browser-driver substitute throws if invoked and is outside the live document paths being tested.

At the followup checkpoint, root `bun run check` passes all 11 tasks and boundary lint. Focused service/quota tests pass 62 tests; focused production/routes/attribution/compose/router tests pass 21 tests. Expanded production workerd fixture also passes with the large-document and published-image regressions. Final combined-main root validation and full-app Clerk browser acceptance remain to be recorded. Local browser acceptance currently needs the controller-managed private signing key; this lane has not altered local secret values or deployed anything.
