# L.8a — Rich document editor components

Implemented independently of room, route, server and compose wiring. Entry point:
`apps/web/src/components/live-artifacts/document-editor.tsx` (`DocumentEditor`).
The parent L.8 task remains responsible for mounting it on the document route.
No generated shadcn component, shared schema/document engine, task file, route or
server file was edited.

## Integration API

`editor-ports.ts` defines the required `DocumentEditorPorts`:

- `document`: the provider-owned Y.Doc. The component binds its `content` XML
  fragment with fresh shared `createExtensions(policy)`, Tiptap Collaboration and
  CollaborationCaret. It never creates an authoritative LiveDocument or replaces
  the injected document. The parent owns connection and document destruction.
- `provider`: a stable `PresencePort` containing that document's Awareness,
  `synced: true`, and stable `getSnapshot` / `subscribe` functions. Mount after
  initial content **and the verified artifact blob manifest** synchronize. The
  roster is authenticated room data keyed by Yjs client ID, including local
  membership. It supplies participant ID, name, color, member/guest/agent kind,
  and agent status with a server-derived `updatedAt` timestamp. Do not construct
  it from raw `awareness.user`. The client overwrites raw user display data with
  this trusted roster and hides unknown clients. Cursor payloads use standard
  y-tiptap `cursor.anchor/head` relative-position JSON. The room adapter must
  translate its canonical awareness protocol to this shape if necessary.
- `role`: owner/editor can mutate. Commenter/viewer receive noneditable content,
  disabled own-history controls, no mutation toolbar or checkpoint restore.
  Programmatic local transactions and Yjs undo/redo are also gated. Approved
  remote changes remain visible. The room must independently enforce access.
- `policy.ownBlobUrls`: the verified own-artifact `/files/...` allowlist. Publish
  manifest changes before corresponding document updates. The stable policy
  getter reads current injected policy without remounting and losing undo.
  Successfully persisted uploads extend a component-owned set. External URLs,
  data URLs and object URLs never enter the document.
- `uploadImage(File)`: actually persist, validate MIME/ownership, and return
  `{url, alt}`. The same callback handles the file input and image paste. The
  editor retains a relative insertion point while awaiting persistence, refuses
  invalid returned paths, and reports failures. Deleting that insertion type
  during an upload can invalidate the insertion point.
- `history.list()`: return typed checkpoint IDs, labels and timestamps.
  `history.restore(id)`: perform an authorized server restore as a new room edit;
  resolve only on success. Do not merge a historical Yjs snapshot into this
  browser document. `history.downloadMarkdown()`: return filename and markdown
  from the latest persisted checkpoint. Loading/errors, restore confirmation and
  a real Blob download are provided by the component.
- `onAskAgent(selection)` and `onCommentSelection(selection)`: required functional
  selection handlers. They receive visible selected text plus Yjs-relative start
  and end JSON, with right/left endpoint association. L.9 owns their panels and
  server actions. Comment selection is hidden for viewers.
- Optional `agentChanges`: attributed relative ranges rendered as mapped view
  decorations, never extra schema marks. Optional `sidebar`: L.9's panel slot;
  it stacks below the document on phones. Its contents must implement their own
  accessible controls and layout.

Keep the provider object and external-store functions stable across ordinary
parent renders. Use a document-keyed mount when switching artifacts so history,
errors and pending actions belong to the right artifact. Errors are visible;
there are no default success callbacks or route/service stand-ins in production.

## Behavior

Toolbar groups cover every in-scope section 4 action: marks, safe links, fixed
text colors and clear formatting; four case transformations; paragraphs,
headings 1–3, bullet/numbered/nested task lists, quote, code, divider and tables;
row/column insertion/removal, header row and fixed cell colors; upload/paste,
trusted participant mentions and date chips; own undo/redo, checkpoint restore
and checkpoint markdown export. Tiptap supplies its standard formatting and
heading shortcuts. A filtered slash menu sits near the caret and supports Enter,
Escape and ArrowDown into its keyboard-focusable actions.

Case edits replace selected text runs in reverse order, retaining their marks,
block structure, chips and untouched content, including Unicode expansion.
History is exclusively Collaboration's Yjs UndoManager, scoped to local
`ySyncPluginKey` origin with separate command captures; there is no ProseMirror
history extension. Tests include simultaneous disconnected typing and each
person's own undo after reconciliation.

Block handles support native drag/drop before/after blocks, touch pointer drops,
and ArrowUp/ArrowDown movement. Moves retain logical IDs in one transaction and
do not replace the whole document. Like the shared engine's move contract,
moving a block can recreate its Yjs types and detach anchors within it; callers
must resolve anchors after structural moves.

Presence includes trusted names/color/kind, remote carets/selections, follow
until wheel/touch/navigation-key/click input, and agent status. Stale agent
status/cursors expire after 4.5 seconds with a 500 ms refresh, even if the final
clear packet is lost. Server clock skew and delivery timing remain integration
concerns. Pending nodes shimmer, with reduced-motion support. Agent attribution
is a dotted underline mapped through editor transactions.

## Shared-schema adapter finding

Tiptap's block insertion/split can copy a paragraph ID into both halves before
UniqueID runs in `appendTransaction`. The shared sanitizer rejects that local
transaction because duplicate-ID sanitation changes its document. The small
adapter in `createDocumentEditor` repairs only duplicate IDs in local
transactions before dispatch, retaining the first ID and assigning a UUID to
later occurrences. It does not change the shared extensions, node definitions,
content policy or remote transaction handling. Image-in-middle tests reproduce
this path and assert the preserved text on both sides. A future shared-schema
change could make this adapter unnecessary; remove it only with the split/image
regressions still passing.

UniqueID also expects an `on/off('synced')` provider when CollaborationCaret has
one. The internal caret adapter delivers that event asynchronously from the
required already-synchronized port, and cancels listeners on teardown. It does
not invent network synchronization or own the room connection.

## Evidence

- Actual Tiptap suite: `bun run --cwd apps/web test
  src/components/live-artifacts/editor.test.ts` — **27 passed**, **154 assertions**.
  Covers every content action group converging in a second actual editor; live
  mark replication, disconnected concurrent typing and scoped undo/redo; case
  marks/chips/Unicode; table operations; safe links/colors; persisted-image
  insertion at a relative location and hotlink refusal; ID-preserving movement;
  relative selection/decorations; role downgrade/remote updates; trusted names,
  expired agent cursors and initial content policy validation.
- Browser command: `bun run
  apps/web/src/components/live-artifacts/fixtures/browser-check.ts`. Builds the
  real React component with Vite, Tailwind and existing app CSS; serves artifacts
  through Playwright request interception, without a server or preview tools.
  Three independent Y.Docs exchange updates, two rendered editors exchange
  awareness, and a fixture controller implements checkpoint restore. Uploads
  persist bytes in the fixture's request handler; export downloads real content.
  This is component acceptance, not an authenticated room/network test.
- Chromium desktop **1280×800** and touch-emulated phone **390×844**: toolbar/case,
  slash/chips, named carets and selections, selection callback payloads, follow
  cancellation, restore/export, image upload/paste, block movement and role
  restrictions pass. Native desktop block drag and keyboard movement both
  propagate to the other replica. The phone also exercises Enter in the slash
  menu. All **138** expanded visible controls are measured at **≥40×40 px**;
  document width is bounded by the viewport. No page errors.

Final verification on branch `t3/live-artifacts-editor-components`:

- Root `bun run check`: **pass**, all 10 tasks successful; boundary lint clean.
- Root `bun run test`: **pass**, all 10 tasks successful; web **3,281 pass**, one
  existing skipped enumeration-race test, zero failures; services **3,082 pass**;
  root script suite **284 pass**, zero failures.
- Root `bun run build`: **pass**, all three tasks successful; client/server build
  and dev-only bundle checks pass. Existing non-failing Vite CSS sourcemap and
  bundle-size warnings remain. The fixture separately bundles the actual editor
  because route wiring intentionally does not import it yet.
- `rg -l drizzle apps/web/dist/client`: no matches.
- Editor import scan for `#/server`, `@repo/db/`, `cloudflare:workers` and
  `createServerFn`: no matches. `git diff --check`: clean.
- Initial missing local env type declarations were resolved by copying the
  example to ignored `apps/web/.env` only when absent, then generating types.
  No secret values or environment files were committed.
- Implementation commits: `9a4fa19e` (binding/commands and editor tests),
  `7435b58b` (UI/presence/history and adapter regressions), `a1bb1067`
  (desktop/mobile fixture). The final handoff commit adds native-drag browser
  evidence and this document.

## Genuine integration gates

1. L.8 mounts the component with a connected, initially synchronized room,
   stable trusted roster/client-ID mapping, live role updates and verified blob
   policy. Verify the room's awareness wire format, identity overwrite,
   authorization, reconnect behavior and agent heartbeat/clock handling.
2. Provide real artifact upload and checkpoint list/restore/export callbacks.
   Blob ownership metadata must arrive before image updates; the browser cannot
   infer ownership from a URL. Restores must use the service/engine's validated
   reconciliation, not the local fixture controller.
3. L.9 mounts actual agent/comments panels, handles the selection callbacks,
   resolves/detaches relative anchors, and supplies agent-change attributions.
   Their phone layout and controls need their own acceptance checks.
4. Repeat with two authenticated browser profiles through real room transport,
   plus an agent, locally and on staging. The fixture verifies rendering and
   real Yjs replicas but cannot certify the 500 ms network caret budget, server
   status expiry, persistence, reconnect, or end-to-end R1.15–21.

No push, PR, deployment or additional checkout was created.

## Independent review — 2026-10-27

Reviewed merged editor `f6beacee` / merge `f86f95ad` in the current checkout against the section 4 and presence, role, undo and checkpoint requirements. Verdict: **changes required** for the component defects below. These are separate from the production room, route, authorization and callback integration gates above.

### Medium — restore confirmation survives a role downgrade

In `editor-history.tsx`, only the initial Restore button is conditional on `editable`; the confirmation block is conditional solely on `confirm`. Repro: as an editor open version history and click Restore, then have the parent update the role to viewer or commenter before confirmation. Confirm restore remains enabled and invokes `port.restore(id)`. Clear the confirmation on downgrade and gate the confirmation and handler on the current role. A properly authorized server must still reject the call; that server boundary does not make the exposed component action correct. This is a code-path reproduction; the existing browser fixture tests static roles, not this transition.

### Medium — removed image-policy URLs remain trusted locally

`use-document-editor.ts` adds every incoming `policy.ownBlobUrls` entry to the long-lived `allowed` set and never removes it. Repro: mount with URL A in the verified manifest, then publish a new manifest excluding A while retaining the same document/provider. The policy getter still contains A, so the shared local sanitizer continues accepting it. Keep separately only URLs successfully persisted by this component and derive current external manifest entries afresh; reconcile uploaded entries when the authoritative manifest changes. The room's independent policy validation remains necessary and can reject an invalid update, but this component does not honor the stated live policy contract. This is a code-path reproduction.

Reviewed shared schema binding, local-origin Yjs undo and role filter, selection/case and block/table commands, uploads and relative anchors, trusted roster projection, caret/follow, lifecycle and mobile controls. Focused actual-editor tests passed: **27 tests, 154 assertions**. The existing Playwright fixture passed desktop 1280×800 and touch phone 390×844, including collaboration, toolbar, chips, uploads, history and 138 measured controls. These fixture results do not establish authenticated transport, real uploads or server authorization. Initial test attempts lacked dependencies; `bun install --frozen-lockfile` resolved them. No product code was changed.

## Controller remediation

Restore confirmation is cleared on downgrade, hidden unless currently editable, and the handler itself checks current editability. Image policy now separates temporary successful uploads from the authoritative manifest, drops stale allowances on manifest changes and promotes acknowledged uploads out of the temporary set. The getter rereads the current manifest synchronously so ownership metadata supplied before a remote image update is effective before React renders. A regression exercises the real sanitizer across removal/upload/acknowledgement/removal; the desktop and phone Playwright flows now downgrade and re-upgrade while a restore confirmation is open. All28 editor tests and both browser flows passed, including remote image propagation. Root checks are running.
