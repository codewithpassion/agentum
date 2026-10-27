# LD.2 — production shared-schema deck rich text

Implemented on `t3/ld2-shared-deck-codec`, based on main containing the validated deck core and L.2 review fixes. Implementation commits: `0f664986` and `84ac904d`. This completes the shared codec leaf; room, editor, services, MCP and product acceptance remain their own lanes.

## API and schema authority

```ts
import { Deck } from "@repo/live-deck";
import { richTextCodec } from "@repo/live-deck/rich-text";

const deck = new Deck(trustedEmptyDoc, richTextCodec);
// For untrusted bytes, call deck.applyUpdate(bytes) or deck.restore(bytes).
```

`richTextCodec` implements the existing synchronous `RichTextCodec` contract: `parse(nodes, attachedFragment)` reconciles a canonical HTML tree into an attached Y.XmlFragment; `serialize(fragment)` validates raw shared XML and returns a detached canonical tree. Both refuse unsupported input instead of sanitizing it. Empty fragments round-trip as `[]`; empty paragraphs as `<p></p>`. These are distinct valid states. Unattached fragments and documents with pending Yjs dependencies are refused. The codec does not accept HTML strings or run a DOM parser; slide-string syntax remains the strict core parser's responsibility.

`@repo/live-doc/rich-text` is a narrow bridge exporting the existing `schema`, `safeLink`, `THEME_COLORS` and the existing version-pinned y-tiptap conversion/reconciliation functions. No schema, extension, content policy or document engine behavior was changed. `live-deck` has a declared workspace dependency on `live-doc`; its codec builds transitively against the same schema and Yjs binding used by documents and editors. The HTML name map is an interchange mapping, not a second ProseMirror schema.

## Supported canonical text

- Paragraphs (`p`), hard breaks (`br`), bullet/ordered lists (`ul`, `ol`, `li`), nested lists and task lists/items. Task lists use `ul data-type="taskList"`; task items use `li data-type="taskItem" data-checked="true|false"` containing paragraphs. Ordered starts are positive safe integers, with default `1` omitted in canonical HTML.
- Shared marks: bold (`strong`), italic (`em`), underline (`u`), strike (`s`), inline code (`code`), links (`a`) and theme text colors (`span style="color: #3b82f6"`, using only the exact shared theme palette). Adjacent text runs share their common mark wrappers. Mark nesting/order is the shared schema's canonical order; invalid exclusions, duplicate marks, redundant empty wrappers and other noncanonical/lossy input are refused before mutation.
- Links carry `href`, `target="_blank"` and `rel="noopener noreferrer"`. URLs must satisfy both live-doc's safeLink and the existing exported deck validateLinkUrl grammar: safe root-relative paths, HTTP(S) or mailto; no executable schemes, credentials, controls, backslashes, protocol-relative paths, malformed escapes or encoded unsafe separators. Arbitrary link classes/titles are outside this subset; the shared schema's null defaults are accepted in raw XML.
- Optional `data-id` retains the shared block `id` attribute; IDs follow the document schema's bounded grammar and must be unique within a fragment. No IDs are invented by serialization. Ordered-list presentation `type` accepts only the shared null default. Element-level typography remains the deck/theme responsibility.
- Text boxes and table cells use the identical codec and schema. Tables themselves remain deck scene elements: shared document table nodes, headings, quotes, fenced code, images, chips, pending blocks, raw HTML and other nodes/marks/attrs are refused inside a text fragment. Unknown event/style attributes and CSS expressions are refused.

XML-illegal controls and unpaired surrogates are refused. Unicode scalar values, combining sequences, RTL scripts, emoji, literal markup, tabs and CR/LF survive rich Yjs and constrained HTML round trips. One necessary core integration change was reported before editing: `escapeHtml` now emits carriage returns as `&#13;`, avoiding XML's otherwise lossy line-ending normalization. This is the only deck-core change.

## Raw boundary and identity

Before ProseMirror projection, serialization checks actual XML node kinds, schema attribute keys, attribute values, raw child content matches, XML text attributes, delta insert kinds and every raw delta mark name/value/key. Unknown marks (including hashed names), hidden attributes on recognized marks, malformed/non-object mark values, duplicate same-type marks and nontext embeds are rejected. This prevents projection from concealing unsupported raw Yjs state. Projected nodes are checked against the exact schema and re-parsed canonical HTML, including mark values and structural restrictions. Depth/node limits match the deck text boundary (16 / 20,000); scene/update/HTML byte and aggregate limits remain enforced by Deck.

Parse validates the complete proposed tree and current target before mutation, then uses the shared `initProseMirrorDoc`/`updateYFragment` reconciliation. Direct codec no-ops retain state vectors; changed text retains existing paragraph/text objects, explicit IDs, untouched sibling types and resolvable relative positions where Yjs allows. Authority binary admission applies the original Yjs update, retaining original client/clock identities and marks; independent text and table-cell edits converge.

The existing Deck whole-text replacement paths clear changed fragments before calling the codec. LD.2 does not rewrite those core semantics; direct codec reconciliation preserves more internal identity than those replacement paths permit. Unchanged core fragments and original admitted editor updates retain their identity. Reparented Yjs sequence types cannot be preserved by an adapter. HTML is an interchange view, not a lossless CRDT checkpoint: persist actual `state.ydoc`.

## Validation evidence (27 October 2026)

- `bun run --cwd packages/live-deck typecheck`: pass.
- `bun run --cwd packages/live-deck test`: **36 pass, 0 fail, 389 assertions**. Includes the existing 25 core tests and 11 production-codec/runtime tests.
- Real shared-schema/Yjs/HTML/deck/checkpoint round trips cover every supported mark, partially overlapping nested marks, nested ordered/bullet/task lists, hard breaks, empty paragraphs, table cells and Unicode samples across all 17 planes. Direct document-schema binding output is accepted by the adapter.
- Adversarial binary tests cover hidden link/simple/color-mark keys, unknown and hashed mark names, duplicate marks, malformed mark values, unsafe links, XML text attributes, XML element attrs/nodes and embedded nontext values. Deck update rejection preserves authoritative bytes and emits no update; malformed checkpoints are refused. Invalid HTML-tree input preserves target bytes and emits no update. Unsupported document-schema blocks and list attrs are refused without source mutation.
- Actual local Miniflare/workerd executes the browser-target bundle at compatibility date `2026-08-19`, with `document` undefined. It round-trips rich table-cell content, admits original marked typing and refuses a binary hidden-link-attribute attack with an unchanged authority state vector. This is executable Worker evidence, not a Bun-only mock.
- Root `bun run check`: pass, **11/11 tasks**, Ultracite and boundary lint clean.
- Root `bun run test`: pass, **11/11 tasks**, **8,198 tests passed** including 284 root script tests; zero failures and one existing web skip. Live-deck: 36 pass; live-doc: 33 pass; services: 3,099 pass; web: 3,254 pass. The final run completed after the last code/test change.
- Root `bun run build`: pass, **4/4 tasks**, including browser builds of both live-deck entry points and live-doc. Existing Vite CSS sourcemap warning is non-failing.
- `bun install --frozen-lockfile --ignore-scripts --network-concurrency 1`: pass, no dependency changes required.
- Bundle boundary checks: `apps/web/dist/client` exists and `rg -l drizzle apps/web/dist/client` has no matches. The emitted live-deck browser bundles have no matches for `cloudflare:workers`, `bun:sqlite` or `@repo/db`. Actual workerd also rejects unsupported platform imports at runtime. `git diff --check`: clean.

The ignored web `.env` was initialized from its example only if absent; existing local values were preserved. No app/editor/room/service/MCP/protocol/schema/migration files or `docs/tasks` were changed. No push, deployment or PR.

## Integration gates

Room and editor owners must inject the production codec, use shared editor extensions with the deck subset enforced, and route every untrusted editor/update/checkpoint through Deck admission. `parse` operates on trusted attached local editor types; it is not a substitute for `Deck.applyUpdate` on network input. Keep authorization, serialized authority admission, own-blob ownership, checkpoint persistence/broadcast and rejected-client resynchronization in the room/service lane. Render validated values using platform components; do not use agent HTML with innerHTML. Browser/editor/service/MCP wiring and staging acceptance remain separate gates; this leaf makes no phase-completion claim.

## Independent review — 27 October 2026

Reviewed merged main `3668697d` (handoff `5722fc90`; checkout `d58284ea`) against LD.2, LD.0, L.2 and PRD §5/R2.5. Verdict: **accepted for the bounded codec leaf; no severity-rated findings**. This is not phase 2 product acceptance.

The adapter imports the actual live-doc `schema` and pinned y-tiptap bindings through the narrow bridge; its tag mapping is not a second schema. Raw XML node kinds, content matches, attributes and text deltas are checked before projection, including unknown and hashed marks, hidden mark keys and embeds. Projected values and canonical input are checked again. The merge's sole core change escapes CR as `&#13;`. The focused suite exercises shared-schema output, safe links, CSS restrictions, Unicode and XML interchange, invalid parse and binary admission atomicity, original Yjs IDs, independent text/table-cell convergence and actual bundled Miniflare/workerd execution without a DOM.

Independent temporary probe: parse `a\r\nb`, try a span with `style="color: #3b82f6; color: red"`, and compare encoded bytes and update-event count after rejection; format a character with `link: {href: "/ok", target: "_blank", rel: "noopener noreferrer", secret: "x"}` and require serialization to throw; serialize and parse the rich slide fixture and require both `&#13;` and deep equality. All passed. These checks sample the boundary; they do not prove every possible Yjs history.

`bun install --frozen-lockfile --ignore-scripts --network-concurrency 1` passed after the initial test could not resolve absent dependencies. `bun run --cwd packages/live-deck test` passed **36 tests, 389 assertions**, including actual workerd; `bun run --cwd packages/live-deck typecheck` passed. No root suite was rerun for this review.

Direct codec reconciliation retains existing types and relative positions in the tested in-place edit; core whole-text and cell replacement explicitly clears changed fragments before parsing, so that stronger identity guarantee does not extend to those paths. Original admitted editor updates preserve their CRDT identities. Room/editor integration must inject the codec and enforce the subset and authenticated serialized admission, persistence, broadcast and rejected-client resynchronization; service/MCP, browser and staging acceptance remain separate gates.

## Controller: structural position-migration boundary (2026-10-27)

The actual two-browser LD.6 list transform reproduced a populated y-tiptap 3.0.10 position-migration map. Ordinary undo may create an unencoded empty local map; the structural transform is encoded and needs authority admission. The captured synthetic browser scene is committed as a reproducible fixture.

Deck validation now accepts only the exact nested-item migration-root grammar, attached to an actual scene text or table-cell fragment. Version-1 records have closed keys; record identity must match its Yjs map item; state-vector entries are bounded and cannot claim unavailable clocks. Source and destination ranges must remain inside that fragment's retained XML ancestry, including deleted history. Root aliases, arbitrary hidden maps, nested shared payloads, cross-fragment references and unknown fields remain rejected. Aggregate history is bounded at 10,000 records, 100,000 transfers/vector entries, 2,000,000 expanded source positions and the existing 16 MB scene limit. Deck disables Yjs garbage collection so deleted ancestry remains verifiable; a fresh scene incarnation is required once retained history reaches bounds. These records are editor position data, not authorization or trusted actor provenance.

Validation: package typecheck; 41 focused tests / 427 assertions, including actual workerd admission/restore of the captured structural scene, restart/restore/deleted-slide history, atomic hostile-update rejection and cross-fragment probes. The original y-tiptap binding is retained after the alternative binding failed peer undo in an initially empty cell. Actual client structural edit/undo acceptance is still an LD.6 gate; no full-app or staging claim.

## Independent review of migration boundary at `1f30cc5f` (2026-10-27)

**Finding — medium: deleted migration-map values bypass the closed grammar.** `validatePositionMigrations` iterates the visible entries of each accepted map, but `gc: false` retains deleted map items and their nested shared types. Starting from `structural-migration.json`, obtain its `__tiptap_position_migrations:item:…` map, and in one Yjs transaction set key `hidden` to a new Y.Map, set `secret` in that map to `payload`, then delete `hidden`. Both `deck.validate()` and `authority.applyUpdate(encodeStateAsUpdate(deck.doc))` succeed; `encodeStateAsUpdate(authority.doc)` still contains `payload`. Thus an admitted editor can persist and distribute arbitrary hidden data under an otherwise valid migration root, contrary to the claimed closed grammar and no arbitrary hidden payloads. The existing nested-payload test leaves the entry live and does not cover this case. Deleted or overwritten invalid records similarly escape the record and aggregate-history counters; the encoded scene limit still bounds total bytes. Inspect retained map history and nested descendants, including overwritten/deleted items, without rejecting legitimate deleted y-tiptap records; add atomic admission, restart and restore regressions. This is not evidence of privilege escalation or unbounded storage.

The captured browser fixture and source show a deliberately narrow root grammar, ancestry/range checks and `gc: false` to preserve referenced XML history. Focused `bun test src/migrations.test.ts src/workerd.test.ts` passed (6 tests, 46 assertions), including real workerd; the separate adversarial probe above passed admission unexpectedly. These results do not establish compatibility for every y-tiptap 3.0.10 structural operation: actual peer editing and undo remain the LD.6 browser gate. Objection/tradeoff: validating deleted history adds work and must tolerate legitimate y-tiptap tombstones; simply rejecting all deleted entries would break normal editing. No phase 2, full-app or staging acceptance is claimed.
