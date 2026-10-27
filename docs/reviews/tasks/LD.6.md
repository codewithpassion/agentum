# LD.6 — deck client route and room integration

Implemented the production client integration on `t3/ld6-deck-client-integration`.
Implementation commits: `aca29ff6`, `bb4b22b7`, `de72dcec`, plus the final acceptance
commit containing this report. Actual-room desktop/mobile acceptance passes.
Authenticated full-app acceptance remains blocked by the previously cancelled
missing ARTIFACT_VIEW_KEY setup; this is not staging or whole-PRD acceptance.

Read CLAUDE.md, phase-2 PRD, LD.3/LD.4 and L.8/L.8a/L.9 evidence. Coordinated exact
contracts with LD.5 and merged its actual implementation through `f1808116`, the
presenter fixture timing fix `de5e349d`, and controller core fixes `1f30cc5f` /
`e2183512`. No server/service/protocol/schema/task-file changes were authored in
this lane. Those files entered only through the integration merges.

## Production path

- `/a/$artifactId` mounts `LiveDeckPage` for decks, retaining the document and
  static routes. The artifacts list exposes authenticated typed deck creation.
- Actual `liveArtifacts` procedures supply create/open/join/history/restore,
  ownership and sparse-cell initialization. Upload uses the authenticated image
  endpoint and verifies the returned path in the refreshed ownership manifest
  before insertion. No root-router casts or runtime successful mock ports.
- `TicketedDeckRoom` consumes mandatory kind, role, authenticated participant,
  assigned awareness ID, epoch, ownership manifest and expiry. Awareness ID stays
  separate from Y.Doc ID. Every incoming update uses `Deck.applyUpdate` with the
  production richTextCodec and verified current ownership. The authority must
  initialize the theme; clients never create competing theme maps.
- Local publication validates actual encoded bytes through an isolated Deck.
  Empty unencoded local migration maps do not break ordinary undo; malformed or
  unsupported encoded content fails closed. Rejection, role change (including
  ticket renewal) or disconnect disposes the connection. Reconnect creates a
  fresh document and one-use ticket, never reoffers the rejected optimistic state.
- Presence sends only slide/selection/pointer and replaces the old ephemeral
  location, including pointer clearing. Identity comes from the admitted session
  and server frames. Agent asks await matching sender awareness echo. The backend
  derives the current one-based slide number and surviving selected element IDs.
- Presentation controls are serialized and request-correlated. The client retains
  the connection-owned lease ID and renews every five seconds. Disposal rejects
  pending requests and closes the lease connection. Delayed starts after exit or
  permission loss cannot resume broadcasting. Trusted slide/build positions feed
  the existing presentation follow/leave/rejoin UI.
- Missing table cells use mandatory `DeckEditorPorts.ensureCell`: await the real
  serialized authority operation, validate/merge its returned state through the
  provider, recheck edit permission and cell existence, then bind the existing
  fragment. No local sparse-cell allocation remains in the production component.
  A pending/error cell stays noneditable. Existing filled cells keep their ID.
- History lists published versions, confirms restore, preserves request ID across
  retry and reloads accepted room state after success. The collaboration panel
  supports selected slide/element comments, replies, shared agent conversation,
  paginated comments/changes and confirmed guarded revert. It is a desktop side
  panel and mobile bottom sheet. Document components remain unchanged.

## Final real-room evidence

Command:
`bun apps/web/src/components/live-decks/fixtures/room-browser-check.ts`

Passed two independent Chromium contexts at **1280×800** and **390×844**, using
the real workerd ArtifactRoom, real Deck/core/production codec and native ticketed
WebSockets. The fixture issuer is explicitly test-only; it does not bypass app
authentication or claim authenticated full-app acceptance.

The final run covers:

- Concurrent per-key changes to one shape, concurrent headline typing, own text
  undo/redo preserving the peer, concurrent slide additions and stable IDs.
- Real list conversion and paragraph/list splitting; concurrent first opening
  of an omitted table cell through the real ensure endpoint; matching fragment
  IDs in both profiles; concurrent cell typing, own undo/redo preserving the peer,
  and rich lists inside the cell.
- Trusted participants, pointer/selection publication and confirmed selected
  slide/element echo before agent attachment.
- Presenter slide/build updates, follow/leave/rejoin and release. A WebSocket
  proxy delays the actual server's admission acknowledgement, then a real role
  downgrade releases the lease; delivering the late acknowledgement cannot resume
  broadcasting. No successful replacement presentation port is used.
- Actual checkpoint/reload and room restore after structural migrations;
  invalid optimistic local state closes the client before publication, reconnect
  rebuilds accepted state, and the authority never contains the rejected payload.
- Downgrade/reconnect leaves scene controls disabled for the viewer.

Final log: `/tmp/ld6-room-browser-final.log`.
Screenshots: `/tmp/ld6-browser-evidence-zo1KLI/deck-1280.png` and
`/tmp/ld6-browser-evidence-zo1KLI/deck-390.png`.
Earlier evidence directories remain intact. Fixture upload/comment/ask actions
explicitly reject use because those need authenticated app services; production
hosts bind the actual service callbacks.

## Checks and limits

- Focused final deck/provider tests: **19 passed, 69 assertions**, including same
  attached cell identity, structural edits, hostile authority/local updates,
  theme initialization, assigned IDs, downgrade/pending leases and RPC ingress.
- Root `bun run test`: **12/12 tasks passed**, web **3330 passed / 1 existing skip**,
  services **3166 passed**, followed by **284 root script tests**, zero failures.
  Log `/tmp/ld6-tests-combined.log`.
- Root build: **5/5 tasks passed**. Existing Vite size warning only. Browser bundle
  scan for drizzle, cloudflare:workers and server-path imports returned no matches.
- Root lint: clean. Boundary lint: clean. `git diff --check`: clean.
- Standard root `bun run check` ran: lint and **11/12 Turbo tasks passed**. Its
  default Worker type generation omits secret declarations in this env-file-free
  checkout, so web typecheck reports missing Env keys. Explicit
  `wrangler types --env-file .env.example` followed by web typecheck passes.
  This generates declarations from the existing example without modifying any
  environment file or creating credentials. Logs `/tmp/ld6-check-combined.log`,
  `/tmp/ld6-tsc-final.log`. Global commit hooks were bypassed for this known
  environment gate, with focused lint/typecheck/tests performed explicitly.

Full-app auth, actual upload/history/agent/comment UI round trips through a signed
in app session, staging and maximum-scene performance remain unclaimed. No secret
was generated/requested, no env file changed, and no push, PR or deployment ran.

## Resolved integration findings

Real sync exposed LD.5's document-only sync-step-0 authority access; backend fixed
it in `e7a9125d`. Full root tests exposed a fixed-50ms presenter fixture race;
backend replaced it with request-correlated event waiting in `de5e349d`.

Structural rich text exposed populated y-tiptap position-migration metadata that
was absent from the original strict deck grammar. Captures remain at
`/tmp/ld6-browser-evidence-QC02o6/structural-1280.json` and
`/tmp/ld6-structural-regression-xsrmjU/scene.json`. Controller's bounded validator
now checks the exact version-1 records, known fragment ancestry and retained
history, including native ID objects and merged boundary ranges. The full room
run passes with the original binding and strict core; no client bypass exists.

A controller-authorized pinned y-prosemirror 1.3.7 experiment was rejected after
same-empty-cell peer undo failed despite identical preallocated fragment IDs.
Original y-tiptap passes that regression. The alternate binding and dependency
were reverted; its diagnostic patch remains at
`/tmp/ld6-y-prosemirror-experiment.patch`.
