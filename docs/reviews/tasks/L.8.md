# L.8 — real document client integration

**Current resumed status:** L.7 mount/endpoints are merged. Authenticated full-app acceptance is blocked before dev login by missing local `ARTIFACT_VIEW_KEY`; the controller's private card was cancelled without a value. No further prompt or key generation was performed. The historical namespace gate below is superseded.

The `/a/$artifactId` route now branches on `document` and mounts `LiveDocumentPage`, rather than opening an artifact iframe. The static viewer remains its own component. The merged L.8a editor is mounted only after a ticketed room session, initial Yjs read synchronization and verified artifact image policy have completed. Main's editor fixes `246b25f1` are included.

## Client implementation

- `room-provider.ts` implements the actual room protocol: binary Yjs sync 0/0–2, awareness 1, presence query 3, plus separate JSON session/renew/renewed/role/error controls. It reads the actual room encoder's `{user, cursor, ...}` awareness shape and validates its trusted identity projection before building the editor roster. Local `awareness.user` never supplies roster identity.
- The assigned awareness ID changes `Awareness.clientID`, independently of `Y.Doc.clientID`. Ticket renewal happens before connection expiry with an acknowledgement deadline. Connection/synchronization has a deadline. Network failures retry with bounded exponential delay; rejected content and authorization changes require an explicit reconnect. Every reconnect allocates a new document and fetches accepted server state, so rejected optimistic edits cannot be replayed into a later session.
- A fresh verified manifest is installed synchronously before applying **each** incoming document update. The editor's merged image policy getter sees the replacement immediately; upload allowances remain governed by L.8a's reconciliation. No URL ownership is inferred from a path or document content.
- Selection asks republish their saved relative cursor and wait for the server's canonical awareness echo before making the HTTP ask. A timeout is visible and cannot silently send an unacknowledged selection. Relative positions are normalized before comparing acknowledgements.
- The factory router's type is re-exported only from `integrations/trpc/types.ts`; the client prefixes typed operations with `liveArtifacts`. There is no cast of the missing typed root router, and no runtime server import in the browser.
- History lists real artifact versions and restores through `liveArtifacts.restore`. Restore controls are owner-only, matching the real service, including downgrade/reupgrade. The upload and checkpoint Markdown ports call real authenticated HTTP routes and validate response shapes. Errors never resolve as placeholder successes.

## Coordinated server contracts / current integration dependency

L.7 owns production composition and these routes. The client has proposed and implemented the following exact contracts; they are pending L.7 confirmation/mount at this evidence checkpoint:

- `GET /api/live-artifacts/:artifactId/policy` → `{ownBlobUrls: string[]}` from verified current artifact ownership.
- `POST /api/live-artifacts/:artifactId/images`, multipart `file` → persisted `{url, alt}`; the manifest must contain the URL before returning.
- `GET /api/live-artifacts/:artifactId/markdown` → `{filename, markdown}` from the latest persisted checkpoint.
- Root namespace `liveArtifacts` from `createLiveArtifactsRouter`; existing `artifacts.versions` supplies checkpoint metadata.
- Recent agent-change relative ranges are also required for the editor's attributed underline. Existing `changes` records expose revisions/run/summary, which do not identify trustworthy text ranges. The client does **not** infer attribution by quote matching.

These are explicit dependencies, not completed production server work. No server composition, service or schema file was authored in this client lane.

## Evidence and limits

Implementation baseline commit: `ae895d3f`; subsequent mobile/protocol/acceptance changes are recorded in the branch log.

- Focused actual editor + provider suite: **38 passed**, **198 assertions** (29 editor tests plus nine transport tests). Tests cover assigned ID independence, initial manifest gating, every-update manifest replacement/removal, trusted roster, acknowledged selection, binary updates, JSON controls, real timer-driven renewal, downgrade, malformed controls, foreign room refusal and rejected-state replacement.
- Existing L.8a browser fixture passes at **1280×800** and **390×844**, 138 expanded controls at least 40×40 px, no horizontal overflow. It now uses owner permissions for checkpoint restore and exercises downgrade/reupgrade confirmation. This is editor component evidence, with explicit fixture upload/history ports.
- The new actual workerd room browser command is `bun run apps/web/src/components/live-artifacts/fixtures/room-browser-check.ts`. Its separate fixture issuer does not certify production Clerk admission, app routes or service endpoints. Both **1280×800** and **390×844** pass against actual workerd WebSockets: ticket/session admission, initial content/policy, trusted server roster, named carets/selections, bidirectional edits, own undo before and after reload, fresh assigned awareness IDs, self-caret exclusion without changing the document ID, blur clearing, late/reloaded-peer presence, commenter/viewer downgrade plus read-only resynchronization and remote updates. Each viewport uses two independent browser contexts.
- Root check, test and build were run successfully during integration; the final rerun is recorded below after the latest changes. The earlier full test pass included web **3294 passed / 1 existing skip**, services **3138 passed**, and root scripts **284 passed**. Build's existing size warning remains; the client bundle scan had no `drizzle` matches.
- Real local dev login, using an authorized copy of the ignored environment file, succeeded through Clerk to `/desk` on port 3118. No credentials were printed or committed. The real app acceptance runner (`apps/web/e2e/live-artifacts.ts`) uses authenticated production HTTP calls and no request interception. At this checkpoint it stops at **`No procedure found on path "liveArtifacts.createDocument"`** because main lacks the L.7 mount. It has not certified a live document route, real image upload, comments, shared agent runs or revert.
- The shared T3 preview browser failed with the host's AppArmor sandbox error. Requested checks use Playwright instead. Test browser local-network permission is explicit where Playwright serves fixture HTML over an actual Miniflare origin.
- Two distinct authenticated members, a real authorized agent runtime, and staging remain acceptance gates. Two local browser profiles using the same dev member must not be reported as two-member speaker validation. No push, PR or deployment was performed.

## Real-protocol regressions found and fixed

The actual workerd browser test found three boundaries that a disconnected editor fixture cannot certify:

1. The server's canonical awareness encoder puts identity under `user`, not at the top level. The adapter validates and extracts that trusted shape before roster publication.
2. Tiptap uses `cursor: null` for blur and publishes `RelativePosition` objects with unused `type`/`tname`/`item` keys set to null. The room accepts a missing cursor and canonical relative-position JSON. The outgoing adapter strips unknown/user fields, omits a cleared cursor and normalizes unused position keys. The actual room replaces its presence object, so omission clears the previous cursor; the two-browser check verifies the peer caret disappears after blur.
3. y-tiptap's default cursor filter compares remote awareness IDs to the Y.Doc ID. The integration replaces that cursor plugin with an explicit comparison to the assigned local awareness ID. A focused regression gives a remote participant the exact local document ID and verifies Bob still renders, Alice does not render as her own remote caret, forged names are hidden, and the document ID remains unchanged.

Unchanged role controls from the server are accepted without disrupting the document. Actual role changes stop the session and require fresh ticket/document synchronization, rather than allowing unaccepted edits to survive a downgrade.

## Final integration-ready validation

- Root `bun run check`: passed after the final client/protocol changes (all 11 tasks; boundary lint clean).
- Root `bun run test`: passed (all 11 tasks); web **3297 passed**, **1 existing skip**, zero failures; services **3138 passed**; root scripts **284 passed**.
- Root `bun run build`: passed (all four tasks), including the actual document route/editor in the production browser build; existing size warning only. `rg -l 'drizzle|cloudflare:workers|#/server/' apps/web/dist/client`: no matches. `git diff --check`: clean.
- Repeated L.8a component browser check after the assigned-ID cursor plugin change: both required viewports pass, 138 visible expanded controls at least 40×40 px.
- Actual workerd two-browser check: both required viewports pass with the protocol/reconnect/permission cases above. The isolated room issuer is test-only; it is not an authenticated production app/service check.
- Full app acceptance remains blocked at the missing `liveArtifacts.createDocument` root mount on main. The authenticated runner reports that gate without manufacturing a successful artifact or substituting service callbacks. L.7/controller have the exact endpoint dependencies and executable acceptance command.

## Independent review — 2026-10-27

Reviewed merged client `4d852d19` at checkout `2e4ac2495a7bfcf608206512179f26c24ea00c76`. Verdict: **changes required**.

### High — renewal can bypass the fresh-document downgrade boundary

In `room-provider.ts`, the renewal ticket response assigns a changed `joined.role` directly to `this.role` and updates the UI, but does not fail or recreate the room. If the server's subsequent `role` control carries that same role, `receiveControl` treats it as unchanged and returns. Thus a downgrade discovered during renewal can leave the old Y.Doc and its optimistic unaccepted structs in the connection, contrary to the fresh-document resynchronization guarantee. A later upgrade/reconnect or sync can offer those structs to the room. Treat any role change discovered by renewal as a reason to dispose and fetch accepted state in a fresh document, and test renewal racing the server role control. This is a code-path finding; the existing downgrade browser fixture does not exercise this ordering.

The binary and JSON control paths, assigned awareness ID separate from Y.Doc ID, canonical cursor normalization, trusted server roster, self filter, policy refresh before incoming updates and late-disposal checks were inspected. The existing real-room fixture exercises normal downgrade, blur, late peers and fresh reconnect; it does not prove the renewal race above. Image safety depends on L.7 providing an authenticated, current, artifact-owned manifest and ensuring uploads are included before returning. Client URL syntax alone is not ownership verification. Namespace, room binding, policy/upload/export endpoints and authoritative attribution ranges remain L.7 gates; missing attribution underlines are an unmet phase-1 requirement, not evidence that the client can infer safe ranges.

Checks at the reviewed SHA: locked dependency installation passed; focused editor/provider tests **38 pass, 198 assertions**. Actual two-context workerd browser fixture passed at 1280×800 and 390×844; editor browser fixture passed at both sizes with 138 controls measured. Initial attempts before installation failed for missing dependencies. These fixture results do not establish authenticated production routes, distinct members, real agent behavior or staging. No preview tools were used.

## Resumed full-app acceptance

Merged main `78fd83f8` (including L.7 checkpoint `1f19b0e3`) into the existing worktree without replacing local environment files or database state. The production root namespace and policy/image/Markdown routes are present. The old missing-procedure gate is superseded.

A clean Vite restart was required after adding the Durable Object exports: an existing HMR process used stale exports and reported `Class extends value undefined`; fresh startup clears that error. Actual API composition then fails with `A private room ticket key is required`: the copied local setup has no nonempty `ARTIFACT_VIEW_KEY`. This is a local configuration gate, reported to controller/L.7; no replacement service, mocked callback, fabricated credential or unauthenticated bypass was introduced. A private secret input was requested, preserving all existing values.

The actual-app runner now also checks persisted image upload, manifest ownership, peer byte fetch and image propagation, Markdown download, and owner restore from the real checkpoint service. It fixes its reply locator to the actual `Post reply` action and reports dev-login endpoint failure immediately. Each run writes a fresh evidence directory, preserving earlier screenshots. These additions have not yet passed through the full app while the signing-key setup is unavailable.

## Independent review remediation

Read review `f94b2fe2af45248916adcece8c55702faa6e95d1`. A role change discovered by ticket renewal now follows the same disposal boundary as a role control: it updates the visible role, fails/closes the connection and sends **no renewal packet**. A subsequent matching role control is ignored by the disposed connection. A real-timer regression inserts optimistic state, observes renewal returning a downgrade, races the matching role control, and verifies a replacement document contains accepted state only.

Focused editor/provider/panel regressions pass: **41 tests, 214 assertions**. The actual two-browser workerd check passes again at both required viewports after this fix; this remains transport/room evidence, not Clerk/service app acceptance. The private-card cancellation leaves the full-app upload/checkpoint/thread/comment/revert runner unexecuted beyond configuration failure. Existing environment values, local database state and earlier screenshots were preserved.

Before the L.7 follow-up, merged-root checks were attempted after changes. Root check stopped on L.7 server fixture/production lint (including increment operators, barrel re-export, complexity and formatting); root test passed the new production integration fixture but then failed with repeated Bun builder `Unexpected reading file` errors in `room.test.ts` and `app-gateway/real-worker.test.ts`. These failures were reported to L.7, whose fixes remain external to this client lane. They supersede the earlier integration-ready all-green result for the resumed tree. Client-only lint passes; final web typecheck/build and bundle scan are recorded with the handoff. At that checkpoint, authoritative `policy.agentChanges` was pending; the merged follow-up and completed client wiring are recorded below.

## L.7 follow-up and authoritative attribution

Merged main `18204b8e`, including L.7 follow-up `b729aadf`. The exact policy response is parsed with the shared protocol `relativePositionSchema`: `{ownBlobUrls, agentChanges: [{id, name, start, end, text}]}`. An omitted optional attribution field means no ranges; malformed relative positions reject the manifest. The provider installs the validated manifest before applying remote document bytes and publishes the resulting stable attribution snapshot to the mounted editor. New manifests remove expired/replaced/deleted ranges; a 30-second policy refresh also clears attribution when no document update arrives. Names/ranges come from the authenticated server's accepted CRDT-origin records, never quote matching or revision heuristics. Unit regressions cover schema rejection, metadata-before-content ordering and removal on the next manifest. The focused suite is now **43 tests / 225 assertions**.

Checkpoint restore retries retain a stable `requestId` for the same unacknowledged action; success clears it so a deliberate later restore is a new action. The no-interception acceptance runner additionally covers actual image upload/policy/peer bytes, persisted Markdown download and v1 restore, but these app interactions remain gated.

The resumed real app attempt after this merge reports **`Real dev login endpoint failed (500); check local server configuration.`** Server logs identify the missing private room signing key during composition. The controller cancelled the private key card without providing a value and instructed no generation or reprompt; that instruction was followed. This run has **zero full-app passed interactions**, no page errors and a fresh evidence directory `/tmp/harbourmaster-l8-browser-1793099282390`. It must not be described as completed phase-1 app acceptance.

Available acceptance after the complete client fixes: actual two-profile workerd browser checks pass at **1280×800** and **390×844**, covering initial content/policy, trusted presence/carets, edits, scoped undo before/after reload, assigned-ID self filtering, blur clearing and commenter/viewer resynchronization. Root check now passes (**12 tasks**, boundary clean), and root build passes (**5 tasks**); the previous server lint failure is superseded by L.7's follow-up. The final root test result is recorded in the handoff after completion. Browser bundle scan for `drizzle`, `cloudflare:workers` and `#/server/` has no matches; diff whitespace check is clean.

Final resumed validation completed successfully after `b729aadf`: root `bun run check` **12/12 tasks**, root `bun run test` **12/12 tasks** (web **3316 passed / 1 existing skip**, services **3144 passed**, root scripts **284 passed**), and root `bun run build` **5/5 tasks**. Boundary lint, browser bundle server-import/drizzle scan and `git diff --check` are clean. This supersedes the pre-follow-up root lint/Bun-builder failures above. The only full-app acceptance result remains the explicit signing-key configuration gate; no UI/service interaction has been promoted to a pass on that basis.
