# L.2 — Shared document engine and integration contract

Implemented in `packages/live-doc`; no DB, migration, protocol or app service wiring changes. The merged `LiveOperationOrigin`, `RelativePositionJSON` and `CommentAnchor` contracts remain unchanged. L.1 is independently reviewed; this package assumes its document positions continue to use Yjs relative-position JSON, not absolute editor offsets. Runtime imports of protocol are erased types, so the browser/Worker build does not pull DB code.

## Public API

`@repo/live-doc/schema` exports `schema`, `extensions`, `createExtensions(policy)`, `createSanitizerPlugin(policy)`, `sanitizeJSON`, `fromMarkdown`, `toMarkdown`, `safeLink`, `BLOCK_TYPES`, `THEME_COLORS` and `ContentPolicy`.

The extension list is the schema authority: paragraphs; headings 1–3; bullet, ordered and nested task lists; list/task items; quotes; fenced code; divider; hard break; tables/rows/header cells/cells including spans, bounded column widths and fixed theme cell colors; own-blob images; inline atomic mention/date chips; pending intent blocks. Marks are bold, italic, underline, strike, code, link and theme text color. Browser history is disabled in StarterKit; add Tiptap Collaboration/carets in the editor. Agent-change underlines can be decorations keyed by the change's relative range and attribution; this schema admits no arbitrary HTML/style mark.

`createExtensions` produces fresh extensions for each editor; its gate validates against the actual editor's schema instance. Always sanitize initial editor JSON, pasted/imported JSON and restored content. Unknown HTML tags/attributes cannot enter through the fixed schema. Invalid editor transactions are rejected before the collaboration binding publishes them. The room remains the authoritative validation boundary even if a browser bypasses that gate.

`@repo/live-doc` exports `LiveDocument`, `createOriginUndo`, `hashBlock`, `DocumentError` and the `Block`, `Outline`, `Target`, `Guard`, `Content`, `Operation`, `CapturedChange`, `DocumentOptions`, `DocumentErrorCode` types.

Construct one `LiveDocument(ydoc, options)` per authoritative room, using the `content` XML fragment. The browser binds the same fragment with the shared extensions. Call `destroy()` before replacing a room controller. Existing nonempty Y.Docs are validated on construction. Do not create an authoritative controller per browser replica or use independently incremented browser revisions as room revisions.

| Method | Contract |
| --- | --- |
| `import(content, origin)` | Sanitized creation/markdown/JSON import or full content replacement, one origin transaction. |
| `applyUpdate(bytes, origin)` | Replica-first validation of untrusted editor Yjs updates. Invalid/incomplete update writes no bytes to the authoritative document. Resend a complete state/diff with dependencies when incomplete. |
| `restoreSnapshot(bytes, origin)` | Validate an isolated checkpoint and reconcile its content as one new user change; does not merge historical tombstones into the room. |
| `json()` / `markdown()` | Rich schema JSON / DOM-free markdown export. |
| `read({sinceRev?, atRev?, blockId?})` | Current or retained outline, full JSON for each returned block, tombstones for delta reads. |
| `apply(ops, origin)` | Preflight the ordered batch on a disposable rich Y.Doc, then execute in one authoritative origin transaction. Returns `{revision, changeId?}`. Only direct edits are supported in phase 1. |
| `position(blockId, offset, assoc?)` / `resolve(position)` | Capture and resolve relative inline positions. Offsets are UTF-16 text offsets; chip labels count as visible text but positions inside an atomic chip are refused. Hard breaks count as one. Deleted blocks/ancestors fail closed. |
| `anchor(blockId, from, to)` / `resolveAnchor(anchor)` | Document comment anchors, right-associated start and left-associated end; deleted/collapsed ranges report detached. |
| `capture(ops, origin)` | Apply and return a replayable `CapturedChange` plus the resulting revision. Persist this record with service attribution. |
| `revert(change, origin)` | Reconstruct that change's origin undo history on a disposable replica, merge current content, and apply the selective undo delta. Works after room restart and retains later human edits. |
| `createOriginUndo(ydoc, origin)` | Low-level Yjs UndoManager scoped to the exact origin object, captureTimeout zero. Create before applying the change; destroy when evicted. Suitable for each person's own history and retained in-memory agent changes. |

## Operations and guards

`Content` is exactly one of `{markdown: string}`, `{text: string}`, `{json: JSONContent}`. JSON is a document root. Plain text becomes a paragraph for structural operations and literal inline text for positional/quoted operations. Markdown supports GFM tables/tasks through the same extensions. Raw HTML tokens are consumed by a private Marked lexer before Tiptap's HTML converter can run, identically with and without a DOM. HTML inside fenced/inline code stays inert code. Markdown is an export format: chips become their labels, pending blocks become readable intent lines, and underline/colors/cell colors/IDs are not a lossless Markdown encoding. Rich checkpoints must retain `state.ydoc`.

- `replace` / `delete`: `{op, target, ifHash?, ifRev?, content?}`. `target: {blockId}` requires both exact guards from the block's read. `target: {find, nth?, blockId?}` targets quoted text, with a one-based `nth`; omit `nth` only when unique. Quoted replacement accepts `{text}` and preserves rich formatting outside the range. Cross-atom/cross-text-type quoted replacements fail closed. Missing replacement content is invalid.
- `insert`: `{op: "insert", content, before?, after?, at?}`. Before/after are stable sibling block IDs; neither appends to the document. A relative `at` inserts literal `{text}` into the captured inline position, including an empty paragraph. Do not convert a previously read absolute numeric offset into a new position after a concurrent edit.
- `move`: `{op: "move", blockId, before?, after?, ifHash, ifRev}`. Preserves stable IDs; invalid nesting and moving into a removed/self descendant fail preflight.
- `set`: `{op: "set", blockId, attrs, type?, ifHash, ifRev}`. Type conversions support paragraph, heading and bullet/ordered/task list kinds; task/list child kinds are converted along with their parent. Set checked state on the task item; set heading level, ordered start, cell color, etc. Only schema attributes survive sanitation.
- `fill`: `{op: "fill", blockId, content}`. Only an existing pending block may be filled. Keeps its ID. A deleted or already-filled pending block fails `block_gone`.
- `table`: `{op: "table", blockId, action, index, ifHash, ifRev}`. Actions: `insertRow`, `deleteRow`, `insertColumn`, `deleteColumn`; zero-based indexes. Insertion accepts the end boundary; deletion retains at least one row/column. Structural row/column ops on merged cells fail closed (merge/split UI is outside phase 1).

`guard_mismatch` includes `current: Block` so the tool can show the person's current text/hash/revision. Never force-retry. Other error codes: `block_gone`, `find_none`, `ambiguous_find`, `invalid_position`, `invalid_content`, `comment_anchor`, `revision_gone`. No partial-success semantics: a later failed guard rejects the whole batch with no state vector/update change and no update event. The room/service should turn these typed errors into tool results and perform authorization/idempotency before calling the engine.

Whole-block replacements reconcile through `updateYFragment`; unchanged rich XML/text retains CRDT identity. New blocks receive unique IDs before the editor joins; unchanged subtrees can retain IDs across rich replacements. A move preserves logical block IDs but may relocate/recreate XML types because Yjs does not support reparenting integrated sequence types; callers must resolve anchors after structural edits and display detached anchors when their original type was deleted.

## Revision and persistence ownership

Outline IDs are explicit unique block IDs (UUIDs for new blocks); preexisting XML without an ID has a stable Yjs `<client-base36>.<clock>` fallback. Hashes are eight lowercase hex digits (FNV-1a over schema JSON, excluding identity attrs); they are conflict hints, not cryptographic authentication. Each visible content/order transaction advances the room revision once. Blocks carry their last changed revision, parent ID and current preorder `index`; `sinceRev` filters changed blocks and supplies deleted IDs. Moves/order changes count as changes. Public projections are cloned so callers cannot mutate engine state.

Persist the authoritative revision alongside room snapshots and pass it back as `options.revision` after wake. The controller retains a bounded in-memory outline history (`historyLimit`, default 100). `atRev` and deltas older than retained history fail `revision_gone`; historical checkpoint lookup is the room/service's responsibility. Do not claim an arbitrary old `atRev` is available after hibernation. Persisted `CapturedChange.before` and `.update` are binary Yjs updates, not a serialised UndoManager; store them in chunked room/R2 storage as appropriate and bind the record to its artifact. The service owns who may revert, retention, summary/time and atomic changeId/idempotency state so one change is reverted once. A live origin manager alone does not survive hibernation.

Optional `protectedRanges()` supplies live unresolved comment anchors. Destructive agent block/quoted/table row-column deletion intersecting them is refused with `comment_anchor`; human deletions are allowed and detach the comment. The service owns comment permissions and persistence. Read/resolve anchors after updates; never cache resolved absolute indexes.

## Trust boundary checklist

- Creation, markdown import, agent content, initial editor JSON, editor transactions, binary editor updates and checkpoint restore use the shared sanitation/validation APIs. Never call raw `Y.applyUpdate` on the authoritative document for untrusted input.
- Nodes, marks and attrs are allowlisted. Colors are exact theme colors. Widths/spans are bounded numbers; no `url()`, `var()`, `expression`, event handlers or HTML nodes. Safe text may contain literal markup characters and is rendered as text.
- Links accept HTTP(S), mailto and safe root-relative paths; control characters, backslashes, protocol-relative and encoded separator paths fail closed. External links carry target blank and noopener/noreferrer.
- Image URLs require exact membership of `ContentPolicy.ownBlobUrls` and a safe same-origin `/files/...` path. The service must build this set from verified ownership for this artifact. Empty policy permits no images. External image fetching/upload and MIME checks belong to the service; the schema never hot-links or fetches images.
- Binary validation checks raw XML attrs before projection and rejects unresolved Yjs dependencies, embedded nontext XML text values, malformed/unknown nodes/marks and schema-unsafe values on a disposable replica. Failed validation leaves authoritative state untouched.

## Primary sources and licences

Consulted 27 October 2026: [Tiptap MarkdownManager](https://tiptap.dev/docs/editor/markdown/api/markdown-manager), [Tiptap UniqueID](https://tiptap.dev/docs/editor/extensions/functionality/uniqueid), [y-tiptap](https://github.com/ueberdosis/y-tiptap), [Yjs relative positions](https://docs.yjs.dev/api/relative-positions), [Yjs UndoManager](https://docs.yjs.dev/api/undo-manager), [Cloudflare Miniflare standards](https://developers.cloudflare.com/workers/testing/miniflare/core/standards/), and [Proof SDK AGENT_CONTRACT](https://github.com/EveryInc/proof-sdk/blob/main/AGENT_CONTRACT.md). Proof's current contract describes scoped roles, idempotency and comment/suggestion/rewrite operations; it does not define our block/hash operation wire format. No source code was copied from Proof or another reference project. Original implementation uses pinned MIT Tiptap/Yjs/Marked APIs and the existing Miniflare/workerd tooling; dependency licence files remain in their packages. No copyleft or paid extensions were added.

## Validation

Focused tests include every op/guard, stale batch writes nothing, rich table/checklist markdown, chips/marks/hard breaks/empty blocks, comment protection/detachment, three independent delayed replicas, concurrent table-cell typing/row insertion, concurrent block reconciliation, deleted pending/positions, scoped undo and restart-safe selective revert. Security tests include hostile JSON/markdown/URLs/styles, deterministic 1,000-case structural fuzz, sanitizer idempotence, DOMSerializer inspection in happy-dom, an independent editor schema transaction gate, malformed binary ingress and incomplete update rejection. Workerd runs the bundled rich schema, DOM-free markdown, tables/checklists, positional ops and undo at compatibility date 2026-08-19; this is local runtime evidence, not staging or browser UI sign-off.

Root checks, final test counts and commit evidence are recorded in the implementation handoff. L.3/L.4/L.8 must integrate these boundaries; this package does not authorize a claim that the unwired product already meets every R1 end-to-end acceptance criterion.

Final verification on 27 October 2026, after implementation commits `32961698` and `1f87583e`:

- `bun run --cwd packages/live-doc typecheck`: pass.
- `bun run --cwd packages/live-doc test`: 31 pass, zero failures, 3,239 assertions. Includes actual local workerd execution, 1,000 structural fuzz cases and 100 cases across every content ingress followed by DOM inspection.
- Root `bun run check`: pass, all 10 tasks successful, boundary lint clean.
- Root `bun run test`: pass, all 10 workspace tasks successful; root script suite 284 pass. Services 3,039 pass; web 3,249 pass with one existing skipped enumeration-race test. No unrelated test failures.
- Root `bun run build`: pass, all 3 build tasks successful, including the new live-doc browser bundles. Existing Vite CSS sourcemap warning is non-failing.
- `bun install --frozen-lockfile --ignore-scripts --network-concurrency 1`: pass. The explicit network concurrency avoids the local Bun resolver stalling during initial installation.
- `rg -l drizzle apps/web/dist/client`: no matches. `git diff --check`: clean.
- Ignored `apps/web/.env` initialized from its example only when absent; existing values were preserved. No secrets printed or committed. No DB/schema/migration, app wiring or `docs/tasks` changes; no push, PR or deployment.

## Independent review — 27 October 2026

Reviewed merged implementation at `282521f0949d1afdc74f0025bc102b2215687739`, including commits `32961698`, `1f87583e` and `1bdcfb5e`, against L.2 and the live-artifacts PRD. Verdict: **changes required before accepting L.2**. The two findings below affect the stated trust and comment-protection boundaries. This review does not certify the unwired end-to-end product.

### Must fix

1. **P1 — Quoted edits can delete protected comment text when an anchor spans inline types.** `packages/live-doc/src/document.ts:653` checks a quoted deletion only when both anchor endpoints resolve to the same Yjs type (`:670`), although `anchor()` accepts endpoints in different types (`:469`). Reproduced with paragraph `abc`, mention chip `X`, text `def`, anchor offsets 1–6, then `delete {find: "bc"}`: the edit succeeds and yields `aXdef`; the comment still reports attached. Compare ranges in a common block-relative coordinate space (or fail closed when overlap cannot be established), including chip and hard-break boundaries; add tests for quoted delete and replace, and both endpoints across types. Also verify `resolveAnchor` handles collapsed/reversed cross-type ranges after human edits.

2. **P2 — Binary validation allows hidden raw mark attributes through projection.** `packages/live-doc/src/document.ts:195` validates only that XmlText delta inserts are strings; `:211` projects through ProseMirror, which discards unknown mark attributes before the clean equality check. Reproduced by formatting a character with `link: {href: "https://example.com", target: "_blank", rel: "noopener noreferrer", evil: "yes"}` on a replica: `applyUpdate` accepts it, and `evil` remains in the authoritative Yjs delta. The rendered projection currently drops that field; this is a raw schema-boundary bypass, not a demonstrated script execution. Validate every raw delta mark name and attribute key/value against the schema and policy before projection, including malformed formatting values; test update rejection without a state-vector or event change and checkpoint/constructor validation as applicable.

### Integration gates and contract mismatches

- `packages/live-doc/src/document.ts:118` and `:628` emit `find_not_found`; the current MCP contract and PRD require `find_none`. Map it explicitly at the service/adapter boundary or align the engine and report; also map `ambiguous_find` and `comment_anchor` to MCP's `find_ambiguous` and `anchor_conflict`, and retain `guard_mismatch.current` in the tool result. This is a controller/integration fix, not a reason to require L.7 in this review.
- `packages/mcp/src/tools/live.ts:36` nests guards in `target`, while engine operations put them beside `target`. The adapter must resolve find targets for insert/move/set/table, extract guards, translate before/after and pending intent into engine JSON, and preserve ordered all-or-nothing semantics. MCP accepts markdown for quoted replacement but engine accepts only literal text; define explicit conversion or reject with a useful validation error. MCP set admits heading levels 4–6 and blockquote/codeBlock conversion while the engine supports levels 1–3 and a narrower conversion set; reconcile rather than silently downgrade. MCP table insertion supplies `cells`, whereas engine `table` inserts empty cells (`packages/live-doc/src/document.ts:929`); preserve the supplied cell values atomically or change the exposed contract. Verify adapter round trips, errors and pending deletion in L.7.
- Room integration must persist revision and captured changes, use verified per-artifact blob policy, validate all untrusted updates through the engine, enforce authorization/idempotent revert and supply current protected ranges. Historical reads after restart require checkpoint storage; the in-memory history is bounded.

### Evidence and limits

After frozen install, `bun run --cwd packages/live-doc test` passed: 31 tests, 3,239 assertions, including the actual bundled Miniflare/workerd test. Existing tests cover rich schema and ingress fuzz, replica convergence, incomplete update rejection and batch atomicity, relative insertion and pending deletion, comment detachment, guards and restart-safe selective undo. Independent probes confirmed normal same-type comment protection and rejection of an unknown mark, and exposed the two cases above. A basic change-then-revert import probe advanced the room revision, but changed block identity; this does not independently establish every same-ID change/revert scenario. No product code was edited. Real multi-runtime MCP wiring and staging/browser integration remain deferred gates.

## Controller review fixes — 2026-10-27

Comment protection now compares shared block-relative offsets across text/chip/hard-break types, and resolves collapsed or reversed cross-type ranges as detached. Raw binary mark names and attribute keys/shapes are checked before projection on updates, restore and construction. Added regression tests for both quoted endpoints, delete/replace, cross-type collapse/reversal, hidden link/simple-mark attributes and malformed values with no authoritative update. Focused engine suite: 33 passed, 3,275 assertions including workerd; package typecheck passed. Engine missing-find error aligned to `find_none`; remaining adapter translations stay L.7 gates.
